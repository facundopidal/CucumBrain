import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { createRequestContext, IPC_PROTOCOL_VERSION } from './lifecycle.js';

const protocolVersion = workerData?.protocolVersion;
const generation = workerData?.generation;
const capability = workerData?.capability;
const pendingAdmissions = new Map();
const activeContexts = new Map();
const BASE_TYPES = new Set([
  'admission-result', 'turn-cancel', 'shutdown'
]);
let bot = null;
let watcher = null;
let intentionalShutdown = false;
let heartbeatTimer = null;
let shutdownTimer = null;

function send(type, fields = {}) {
  if (!parentPort || intentionalShutdown && type !== 'shutdown-ack') return false;
  try {
    parentPort.postMessage({ ...fields, protocolVersion, type, generation, capability });
    return true;
  } catch {
    return false;
  }
}

function requestAdmission(kind) {
  const requestKey = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAdmissions.delete(requestKey);
      resolve(null);
    }, 2_000);
    pendingAdmissions.set(requestKey, { resolve, timer });
    send('request-admission', { requestKey, kind });
  });
}

function sendContextEvent(context, stage, status, durationMs) {
  if (!context || !context.isActive()) return;
  send('event', {
    turnGeneration: context.generation,
    turnCapability: context.turnCapability,
    event: {
      kind: stage === 'polling' ? 'polling' : 'stage',
      stage,
      status,
      requestId: context.requestId,
      ...(durationMs === undefined ? {} : { durationMs })
    }
  });
}

async function withRequestLifecycle(kind, operation, ctx) {
  const admission = await requestAdmission(kind);
  if (!admission?.accepted || !admission.context) {
    if (typeof ctx?.reply === 'function') {
      try {
        await ctx.reply('⏳ El sistema está procesando otra consulta. Por favor intenta en unos segundos.');
      } catch {}
    }
    return false;
  }
  const lease = admission.context;
  const context = createRequestContext({
    generation: lease.turnGeneration,
    requestId: lease.requestId,
    budgetMs: lease.budgetMs,
    sharedCancellation: lease.sharedCancellation,
    onStage: (stage) => send('turn-stage', {
      turnGeneration: lease.turnGeneration,
      turnCapability: lease.turnCapability,
      requestId: lease.requestId,
      phase: stage.phase,
      stage: stage.stage,
      durationMs: stage.durationMs
    })
  });
  context.turnCapability = lease.turnCapability;
  activeContexts.set(lease.turnGeneration, context);
  let failed = false;
  try {
    context.assertActive();
    await operation(context);
    context.assertActive();
    return true;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    activeContexts.delete(lease.turnGeneration);
    const status = !context.isActive()
      ? 'cancelled'
      : failed
        ? 'failed'
        : 'completed';
    send('turn-end', {
      turnGeneration: lease.turnGeneration,
      turnCapability: lease.turnCapability,
      requestId: lease.requestId,
      status
    });
  }
}

function isFatalPollingError(error) {
  if (error?.updateHandlerFailure === true) return false;
  const status = Number(error?.code ?? error?.status ?? error?.statusCode);
  return status === 401 || status === 409 || error?.fatalPolling === true;
}

export { isFatalPollingError };

export function attachPollingReadiness(bot, onSuccessfulPoll) {
  if (typeof bot?.telegram?.callApi !== 'function') {
    throw new TypeError('A Telegram client is required for polling readiness');
  }
  const callApi = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.callApi = async (method, payload, options) => {
    const preparedPayload = method === 'getUpdates' ? { ...payload, timeout: 5 } : payload;
    const result = await callApi(method, preparedPayload, options);
    if (method === 'getUpdates') onSuccessfulPoll?.();
    return result;
  };
  return bot;
}

async function handleShutdown() {
  if (intentionalShutdown) return;
  intentionalShutdown = true;
  clearInterval(heartbeatTimer);
  for (const context of activeContexts.values()) context.cancel('shutdown');
  try { watcher?.close(); } catch {}
  try { bot?.stop('guardian-shutdown'); } catch {}
  shutdownTimer = setTimeout(() => send('shutdown-ack'), 25);
  shutdownTimer.unref?.();
}

function handleParentMessage(message) {
  if (!message || message.protocolVersion !== protocolVersion || protocolVersion !== IPC_PROTOCOL_VERSION
    || message.generation !== generation || message.capability !== capability) return;
  if (!BASE_TYPES.has(message.type)) return;
  const allowed = message.type === 'admission-result'
    ? ['protocolVersion', 'generation', 'capability', 'type', 'requestKey', 'accepted', 'reason', 'context']
    : message.type === 'turn-cancel'
      ? ['protocolVersion', 'generation', 'capability', 'type', 'turnGeneration', 'turnCapability', 'reason']
      : ['protocolVersion', 'generation', 'capability', 'type', 'signalName'];
  if (Object.keys(message).some((key) => !allowed.includes(key))) return;
  if (message.type === 'admission-result') {
    const pending = pendingAdmissions.get(message.requestKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAdmissions.delete(message.requestKey);
    pending.resolve(message);
    return;
  }
  if (message.type === 'turn-cancel') {
    const context = activeContexts.get(message.turnGeneration);
    if (context?.turnCapability === message.turnCapability) context.cancel(message.reason || 'guardian-cancelled');
    return;
  }
  if (message.type === 'shutdown') void handleShutdown();
}

async function runTestScenario(scenario) {
  send('ready');
  if (scenario === 'stale-packet') {
    parentPort.postMessage({ protocolVersion, type: 'heartbeat', generation: generation - 1, capability });
  } else if (scenario === 'arbitrary-module') {
    parentPort.postMessage({ protocolVersion, type: 'load-module', generation, capability, module: 'file:///tmp/unsafe-module.js' });
  } else if (scenario === 'cleanup-hang') {
    parentPort.once('message', (message) => {
      if (message?.type === 'shutdown') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  } else if (scenario === 'cancel-ack') {
    const first = await requestAdmission('text');
    if (!first?.accepted || !first.context) return;
    const lease = first.context;
    const context = createRequestContext({
      generation: lease.turnGeneration,
      requestId: lease.requestId,
      budgetMs: lease.budgetMs,
      sharedCancellation: lease.sharedCancellation
    });
    context.turnCapability = lease.turnCapability;
    activeContexts.set(lease.turnGeneration, context);
    send('turn-stage', {
      turnGeneration: lease.turnGeneration,
      turnCapability: lease.turnCapability,
      requestId: lease.requestId,
      phase: 'start',
      stage: 'tool',
      durationMs: 35
    });
    await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
    activeContexts.delete(lease.turnGeneration);
    send('turn-end', {
      turnGeneration: lease.turnGeneration,
      turnCapability: lease.turnCapability,
      requestId: lease.requestId,
      status: 'cancelled'
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const next = await requestAdmission('text');
    if (next?.accepted && next.context) {
      send('event', { event: { kind: 'worker', stage: 'admission', status: 'completed', requestId: randomUUID() } });
      send('turn-end', {
        turnGeneration: next.context.turnGeneration,
        turnCapability: next.context.turnCapability,
        requestId: next.context.requestId,
        status: 'completed'
      });
    } else {
      send('event', { event: { kind: 'worker', stage: 'admission', status: 'failed', requestId: randomUUID() } });
    }
  } else if (scenario === 'sync-stall') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } else if (scenario === 'fatal-poll') {
    send('fatal', { reason: 'polling-failed' });
  }
  await new Promise(() => {});
}

async function runWorker() {
  if (isMainThread || !parentPort) return;
  parentPort.on('message', handleParentMessage);
  if (process.env.NODE_ENV === 'test' && workerData?.testScenario) {
    await runTestScenario(workerData.testScenario);
    return;
  }

  const botModule = await import('../bot/bot.js');
  const { createBotRuntime } = botModule;
  if (typeof createBotRuntime !== 'function') throw new Error('Owned bot runtime is unavailable');
  const runtime = createBotRuntime({
    withRequestLifecycle,
    onUpdate: () => send('update-success')
  });
  bot = runtime.bot;

  const watcherModule = await import('../watcher/watcher.js');
  watcher = watcherModule.default;
  const indexer = await import('../database/indexer.js');
  void indexer.ensureVaultIndexed().catch(() => {
    send('event', { event: { kind: 'worker', stage: 'index_update', status: 'failed', requestId: randomUUID() } });
  });

  heartbeatTimer = setInterval(() => send('heartbeat'), 10_000);
  heartbeatTimer.unref?.();
  send('ready');

  if (!bot) {
    console.warn('[Worker] No se pudo inicializar el bot (TELEGRAM_BOT_TOKEN no configurada).');
    send('unconfigured');
    return;
  }

  attachPollingReadiness(bot, () => {
    console.log('[Worker] Telegram getUpdates confirmado exitoso.');
    send('poll-success');
  });

  try {
    console.log('[Worker] Lanzando polling de Telegram con bot.launch()...');
    await bot.launch();
    console.log('[Worker] bot.launch() ha terminado.');
    if (!intentionalShutdown) send('fatal', { reason: 'polling-ended' });
    else send('polling-stopped');
  } catch (error) {
    console.error('[Worker] Error durante bot.launch():', error);
    if (intentionalShutdown) {
      send('polling-stopped');
      return;
    }
    send('fatal', { reason: isFatalPollingError(error) ? 'polling-failed' : 'startup-failed' });
  }
}

if (!isMainThread && parentPort) {
  void runWorker().catch((err) => {
    console.error('[Worker] Error fatal no capturado en runWorker():', err);
    send('fatal', { reason: 'startup-failed' });
  });
}
