import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export class TurnCancelledError extends Error {
  constructor(reason = 'cancelled') {
    super(`Turn cancelled: ${reason}`);
    this.name = 'TurnCancelledError';
    this.code = 'TURN_CANCELLED';
    this.reason = reason;
  }
}

function makeCancellationView(sharedCancellation) {
  const buffer = sharedCancellation instanceof SharedArrayBuffer
    ? sharedCancellation
    : new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  if (buffer.byteLength < Int32Array.BYTES_PER_ELEMENT) {
    throw new TypeError('Cancellation buffer is too small');
  }
  return { buffer, flag: new Int32Array(buffer, 0, 1) };
}

export function createTurnContext({
  generation,
  requestId = randomUUID(),
  budgetMs = 70_000,
  sharedCancellation,
  parent = null,
  onStage = null,
  now = () => performance.now()
} = {}) {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError('A non-negative turn generation is required');
  }
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new TypeError('Turn budget must be a positive finite number');
  }

  const { buffer, flag } = makeCancellationView(sharedCancellation);
  const controller = new AbortController();
  const startedAt = now();
  const deadline = Math.min(startedAt + budgetMs, parent?.deadline ?? Number.POSITIVE_INFINITY);
  let cancellationReason = null;

  const context = {
    generation,
    requestId,
    signal: controller.signal,
    sharedCancellation: buffer,
    deadline,
    startedAt,
    get remainingMs() {
      return Math.max(0, deadline - now());
    },
    get cancellationReason() {
      return cancellationReason;
    },
    isActive() {
      if (parent && !parent.isActive()) {
        context.cancel(parent.cancellationReason || 'parent-cancelled');
      }
      if (Atomics.load(flag, 0) !== 0) {
        if (!controller.signal.aborted) {
          cancellationReason ||= 'guardian-cancelled';
          controller.abort(new TurnCancelledError(cancellationReason));
        }
        return false;
      }
      if (now() >= deadline) {
        context.cancel('deadline');
        return false;
      }
      return !controller.signal.aborted;
    },
    assertActive() {
      if (!context.isActive()) {
        throw new TurnCancelledError(cancellationReason || 'cancelled');
      }
    },
    cancel(reason = 'cancelled') {
      cancellationReason ||= reason;
      if (!parent) {
        Atomics.store(flag, 0, 1);
      }
      if (!controller.signal.aborted) {
        controller.abort(new TurnCancelledError(cancellationReason));
      }
    },
    child(maxBudgetMs, stageName = 'child') {
      const childBudget = Math.min(maxBudgetMs, context.remainingMs);
      context.assertActive();
      const child = createTurnContext({
        generation,
        requestId,
        budgetMs: Math.max(1, childBudget),
        sharedCancellation: context.sharedCancellation,
        parent: context,
        onStage,
        now
      });
      child.stageName = stageName;
      return child;
    },
    async runStage(stage, budgetMsForStage, operation) {
      context.assertActive();
      const stageContext = context.child(budgetMsForStage, stage);
      const stageBudget = Math.max(1, Math.min(budgetMsForStage, context.remainingMs));
      const stageStartedAt = now();
      onStage?.({ phase: 'start', generation, requestId, stage, durationMs: stageBudget });
      const timer = setTimeout(() => stageContext.cancel('stage-timeout'), stageBudget);
      timer.unref?.();
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(stageContext.signal.reason || new TurnCancelledError('stage-cancelled'));
        if (stageContext.signal.aborted) onAbort();
        else stageContext.signal.addEventListener('abort', onAbort, { once: true });
      });
      const work = Promise.resolve().then(() => {
        stageContext.assertActive();
        return operation(stageContext);
      });
      // A timed-out operation may still settle later; keep its rejection observed.
      void work.catch(() => {});
      try {
        const result = await Promise.race([work, aborted]);
        context.assertActive();
        stageContext.assertActive();
        return result;
      } finally {
        clearTimeout(timer);
        stageContext.signal.removeEventListener('abort', onAbort);
        const elapsedMs = Math.max(0, Math.round(now() - stageStartedAt));
        onStage?.({ phase: 'end', generation, requestId, stage, durationMs: elapsedMs });
      }
    }
  };

  if (parent?.signal) {
    if (parent.signal.aborted) {
      context.cancel(parent.cancellationReason || 'parent-cancelled');
    } else {
      parent.signal.addEventListener('abort', () => {
        context.cancel(parent.cancellationReason || 'parent-cancelled');
      }, { once: true });
    }
  }

  return context;
}

/** Check and invoke an effect in one synchronous turn, after its async preparation. */
export function startEffect(context, initiate) {
  if (typeof initiate !== 'function') throw new TypeError('Effect initiator must be a function');
  context?.assertActive?.();
  return initiate();
}

export function isTurnCancelled(error) {
  return error?.code === 'TURN_CANCELLED' || error?.name === 'AbortError';
}
