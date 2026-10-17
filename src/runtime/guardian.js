import { randomBytes, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createEventStore, operationalDirectory } from '../observability/events.js';
import { createHealthTracker, writeHealthSnapshot } from '../observability/health.js';
import { IPC_PROTOCOL_VERSION, LIFECYCLE_BUDGETS } from './lifecycle.js';

const PACKET_TYPES = new Set([
  'ready', 'unconfigured', 'heartbeat', 'poll-success', 'update-success',
  'polling-stopped', 'fatal', 'request-admission', 'turn-stage', 'turn-end',
  'event', 'shutdown-ack'
]);
const MESSAGE_TYPES = new Set(['admission-result', 'turn-cancel', 'shutdown']);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKET_FIELDS = Object.freeze({
  ready: [], unconfigured: [], heartbeat: [], 'poll-success': [], 'update-success': [],
  'polling-stopped': [], 'shutdown-ack': [],
  fatal: ['reason'],
  'request-admission': ['requestKey', 'kind'],
  'turn-stage': ['turnGeneration', 'turnCapability', 'requestId', 'phase', 'stage', 'durationMs'],
  'turn-end': ['turnGeneration', 'turnCapability', 'requestId', 'status'],
  event: ['turnGeneration', 'turnCapability', 'event']
});
const STAGES = new Set([
  'startup', 'admission', 'download', 'transcription', 'consolidation',
  'llm', 'tool', 'note_write', 'history_write', 'memory_write',
  'index_update', 'telegram_send', 'polling', 'cleanup', 'viewer'
]);
const STATUS_SET = new Set([
  'started', 'completed', 'failed', 'cancelled', 'timed_out', 'stopped',
  'online', 'stale', 'missing', 'unknown', 'rejected', 'unconfigured', 'ready'
]);

export function getOwnedWorkerUrl() {
  return new URL('./bot-worker.js', import.meta.url);
}

export function validateWorkerPacket(packet, generation, capability) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return false;
  if (!PACKET_TYPES.has(packet.type)
    || packet.protocolVersion !== IPC_PROTOCOL_VERSION
    || packet.generation !== generation
    || packet.capability !== capability) return false;
  const allowedFields = new Set(['protocolVersion', 'type', 'generation', 'capability', ...(PACKET_FIELDS[packet.type] || [])]);
  if (Object.keys(packet).some((key) => !allowedFields.has(key))) return false;
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(packet)); } catch { return false; }
  if (bytes > 8 * 1024) return false;
  if (packet.type === 'request-admission') {
    return REQUEST_ID.test(packet.requestKey || '') && ['text', 'audio', 'command'].includes(packet.kind);
  }
  if (packet.type === 'turn-stage') {
    return Number.isInteger(packet.turnGeneration)
      && REQUEST_ID.test(packet.requestId || '')
      && REQUEST_ID.test(packet.turnCapability || '')
      && ['start', 'end'].includes(packet.phase)
      && STAGES.has(packet.stage)
      && Number.isFinite(packet.durationMs)
      && packet.durationMs >= 0
      && packet.durationMs <= LIFECYCLE_BUDGETS.totalMs;
  }
  if (packet.type === 'turn-end') {
    return Number.isInteger(packet.turnGeneration)
      && REQUEST_ID.test(packet.requestId || '')
      && REQUEST_ID.test(packet.turnCapability || '')
      && STATUS_SET.has(packet.status);
  }
  if (packet.type === 'event') {
    const event = packet.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const fields = ['kind', 'stage', 'status', 'requestId', 'durationMs', 'attempt', 'provider', 'deploymentSha'];
    if (Object.keys(event).some((key) => !fields.includes(key))) return false;
    return ['request', 'stage', 'polling', 'worker', 'viewer'].includes(event.kind)
      && STATUS_SET.has(event.status)
      && STAGES.has(event.stage)
      && REQUEST_ID.test(event.requestId || '')
      && (event.durationMs === undefined || Number.isFinite(event.durationMs) && event.durationMs >= 0 && event.durationMs <= LIFECYCLE_BUDGETS.totalMs)
      && (event.attempt === undefined || Number.isInteger(event.attempt) && event.attempt >= 0 && event.attempt <= LIFECYCLE_BUDGETS.maxProviderAttempts)
      && (event.provider === undefined || ['gemini', 'groq', 'openrouter'].includes(event.provider))
      && (event.deploymentSha === undefined || typeof event.deploymentSha === 'string' && /^[a-f0-9]{7,40}$/i.test(event.deploymentSha))
      && ((packet.turnGeneration === undefined && packet.turnCapability === undefined)
        || Number.isInteger(packet.turnGeneration) && packet.turnGeneration > 0 && REQUEST_ID.test(packet.turnCapability || ''));
  }
  if (packet.type === 'fatal') return ['startup-failed', 'polling-failed', 'polling-ended', 'worker-error'].includes(packet.reason);
  return true;
}

function randomCapability() {
  return randomBytes(24).toString('base64url');
}

function validTestScenario(scenario) {
  return process.env.NODE_ENV === 'test'
    && ['sync-stall', 'arbitrary-module', 'stale-packet', 'cleanup-hang', 'cancel-ack', 'fatal-poll'].includes(scenario)
    ? scenario
    : undefined;
}

export function startGuardian(options = {}) {
  const startupTimeoutMs = Number.isFinite(options.startupTimeoutMs) ? options.startupTimeoutMs : 60_000;
  const shutdownGraceMs = Number.isFinite(options.shutdownGraceMs) ? options.shutdownGraceMs : LIFECYCLE_BUDGETS.cleanupMs;
  const cleanupMs = Number.isFinite(options.cleanupMs) ? options.cleanupMs : LIFECYCLE_BUDGETS.cleanupMs;
  const testScenario = validTestScenario(options.testScenario);
  const events = createEventStore({ directory: operationalDirectory() });
  const health = createHealthTracker({
    deploymentSha: process.env.DEPLOYED_SHA || process.env.GIT_SHA
  });
  let worker = null;
  let workerGeneration = 0;
  let workerCapability = null;
  let workerStopping = false;
  let fatal = false;
  let intentionalShutdown = false;
  let turnGeneration = 0;
  let exitTimer = null;
  let startupTimer = null;
  let pollTimer = null;
  let healthTimer = null;
  let replacingWorker = false;
  const leases = new Map();
  const auxKinds = new Map();

  const writeHealth = () => {
    void writeHealthSnapshot(health.snapshot(), operationalDirectory()).catch(() => {});
  };
  const record = (event) => {
    events.record(event);
  };
  const recordStatus = (stage, status, requestId = randomUUID(), durationMs) => {
    record({ kind: stage === 'polling' ? 'polling' : 'worker', stage, status, requestId, durationMs });
    writeHealth();
  };
  const post = (message) => {
    if (!worker || workerStopping || fatal) return false;
    try {
      worker.postMessage({
        ...message,
        protocolVersion: IPC_PROTOCOL_VERSION,
        generation: workerGeneration,
        capability: workerCapability
      });
      return true;
    } catch {
      return false;
    }
  };

  function clearLease(lease) {
    clearTimeout(lease.deadlineTimer);
    clearTimeout(lease.stageTimer);
    clearTimeout(lease.cleanupTimer);
    leases.delete(lease.turnGeneration);
    if (lease.kind !== 'command') auxKinds.delete(lease.kind);
  }

  function cancelLease(lease, reason) {
    if (!lease || lease.cancelled || !leases.has(lease.turnGeneration)) return;
    lease.cancelled = true;
    lease.cancelReason = reason;
    Atomics.store(new Int32Array(lease.sharedCancellation), 0, 1);
    post({
      type: 'turn-cancel',
      turnGeneration: lease.turnGeneration,
      turnCapability: lease.turnCapability,
      reason
    });
    clearTimeout(lease.stageTimer);
    lease.cleanupTimer = setTimeout(() => {
      if (!leases.has(lease.turnGeneration) || fatal) return;
      replaceUnsafeWorker(`unresponsive-${reason}`);
    }, cleanupMs);
    lease.cleanupTimer.unref?.();
  }

  function replaceUnsafeWorker(reason) {
    if (replacingWorker || fatal) return;
    replacingWorker = true;
    workerStopping = true;
    for (const lease of [...leases.values()]) {
      Atomics.store(new Int32Array(lease.sharedCancellation), 0, 1);
      clearLease(lease);
    }
    auxKinds.clear();
    const oldWorker = worker;
    const terminatePromise = oldWorker ? oldWorker.terminate() : Promise.resolve();
    const guard = setTimeout(() => fatalShutdown('worker-error'), shutdownGraceMs);
    guard.unref?.();
    terminatePromise.then(() => {
      clearTimeout(guard);
      if (fatal || intentionalShutdown) return;
      worker = null;
      workerStopping = false;
      replacingWorker = false;
      health.markWorkerMissing();
      recordStatus('cleanup', 'completed');
      spawnWorker();
    }).catch(() => fatalShutdown('worker-error'));
    recordStatus('cleanup', 'timed_out', randomUUID());
    void reason;
  }

  function fatalShutdown(reason) {
    if (fatal || intentionalShutdown) return;
    console.error(`[Guardian] Apagado fatal: ${reason}`);
    fatal = true;
    workerStopping = true;
    process.exitCode = 1;
    clearTimeout(startupTimer);
    clearInterval(pollTimer);
    clearInterval(healthTimer);
    for (const lease of [...leases.values()]) {
      Atomics.store(new Int32Array(lease.sharedCancellation), 0, 1);
      clearLease(lease);
    }
    auxKinds.clear();
    health.markWorkerFailed();
    recordStatus('startup', 'failed', randomUUID());
    record({ kind: 'worker', stage: 'cleanup', status: 'started' });
    writeHealth();
    try { worker?.postMessage({ protocolVersion: IPC_PROTOCOL_VERSION, generation: workerGeneration, capability: workerCapability, type: 'shutdown' }); } catch {}
    if (worker) void worker.terminate().catch(() => {});
    exitTimer = setTimeout(() => process.exit(1), shutdownGraceMs);
    exitTimer.unref?.();
    void reason;
  }

  function gracefulShutdown(signalName) {
    if (intentionalShutdown || fatal) return;
    intentionalShutdown = true;
    workerStopping = true;
    clearTimeout(startupTimer);
    clearInterval(pollTimer);
    clearInterval(healthTimer);
    for (const lease of [...leases.values()]) cancelLease(lease, 'shutdown');
    health.markWorkerStopped();
    recordStatus('cleanup', 'started');
    writeHealth();
    try { worker?.postMessage({ protocolVersion: IPC_PROTOCOL_VERSION, generation: workerGeneration, capability: workerCapability, type: 'shutdown', signalName }); } catch {}
    if (worker) void worker.terminate().catch(() => {});
    exitTimer = setTimeout(() => process.exit(0), shutdownGraceMs);
    exitTimer.unref?.();
  }

  function requestAdmission(packet) {
    if (fatal || intentionalShutdown || workerStopping) {
      post({ type: 'admission-result', requestKey: packet.requestKey, accepted: false, reason: 'stopping' });
      return;
    }
    if (packet.kind !== 'command' && [...leases.values()].some((lease) => lease.kind !== 'command')) {
      post({ type: 'admission-result', requestKey: packet.requestKey, accepted: false, reason: 'busy' });
      return;
    }
    if (packet.kind === 'command' && auxKinds.size >= 2) {
      post({ type: 'admission-result', requestKey: packet.requestKey, accepted: false, reason: 'busy' });
      return;
    }

    const budgetMs = packet.kind === 'command' ? 5_000 : LIFECYCLE_BUDGETS.totalMs;
    const turnGenerationId = ++turnGeneration;
    const requestId = randomUUID();
    const turnCapability = randomUUID();
    const sharedCancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const lease = {
      kind: packet.kind,
      turnGeneration: turnGenerationId,
      requestId,
      turnCapability,
      sharedCancellation,
      startedAt: Date.now(),
      budgetMs,
      cancelled: false,
      stageTimer: null,
      cleanupTimer: null,
      deadlineTimer: null
    };
    leases.set(turnGenerationId, lease);
    if (packet.kind !== 'command') auxKinds.set(packet.kind, turnGenerationId);
    lease.deadlineTimer = setTimeout(() => cancelLease(lease, 'deadline'), budgetMs);
    lease.deadlineTimer.unref?.();
    record({ kind: 'request', stage: 'admission', status: 'started', requestId });
    post({
      type: 'admission-result',
      requestKey: packet.requestKey,
      accepted: true,
      context: {
        turnGeneration: turnGenerationId,
        requestId,
        turnCapability,
        sharedCancellation,
        budgetMs
      }
    });
  }

  function handleTurnPacket(packet) {
    const lease = leases.get(packet.turnGeneration);
    if (!lease || packet.turnCapability !== lease.turnCapability || packet.requestId !== lease.requestId) {
      record({ kind: 'worker', stage: 'admission', status: 'rejected', requestId: randomUUID() });
      return;
    }
    if (lease.cancelled) {
      if (packet.type === 'turn-end') {
        clearLease(lease);
        record({ kind: 'request', stage: 'admission', status: 'cancelled', requestId: lease.requestId, durationMs: Date.now() - lease.startedAt });
      }
      return;
    }
    if (packet.type === 'turn-stage') {
      clearTimeout(lease.stageTimer);
      if (packet.phase === 'start' && packet.stage !== 'admission') {
        const duration = Math.max(1, Math.min(packet.durationMs, lease.budgetMs));
        lease.stageTimer = setTimeout(() => cancelLease(lease, 'stage-timeout'), duration);
        lease.stageTimer.unref?.();
        record({ kind: 'stage', stage: packet.stage, status: 'started', requestId: lease.requestId });
      } else if (packet.phase === 'end') {
        record({ kind: 'stage', stage: packet.stage, status: 'completed', requestId: lease.requestId, durationMs: packet.durationMs });
      }
      return;
    }
    if (packet.type === 'turn-end') {
      clearLease(lease);
      record({ kind: 'request', stage: 'admission', status: lease.cancelled ? 'cancelled' : packet.status, requestId: lease.requestId, durationMs: Date.now() - lease.startedAt });
    }
  }

  function handleWorkerMessage(packet, expectedGeneration, expectedCapability) {
    if (!validateWorkerPacket(packet, expectedGeneration, expectedCapability)) {
      record({ kind: 'worker', stage: 'startup', status: 'rejected' });
      return;
    }
    if (packet.type === 'request-admission') {
      requestAdmission(packet);
      return;
    }
    if (packet.type === 'turn-stage' || packet.type === 'turn-end') {
      handleTurnPacket(packet);
      return;
    }
    if (packet.type === 'event') {
      if (packet.turnGeneration !== undefined) {
        const lease = leases.get(packet.turnGeneration);
        if (!lease || lease.cancelled || lease.turnCapability !== packet.turnCapability || lease.requestId !== packet.event?.requestId) return;
      }
      record(packet.event);
      return;
    }
    if (packet.type === 'ready') {
      console.log('[Guardian] Worker reportó estado READY.');
      health.markWorkerReady();
      recordStatus('startup', 'ready');
      return;
    }
    if (packet.type === 'unconfigured') {
      console.warn('[Guardian] Worker reportó que el bot no está configurado (verificar TELEGRAM_BOT_TOKEN en .env).');
      clearTimeout(startupTimer);
      health.markWorkerStopped();
      recordStatus('startup', 'unconfigured');
      return;
    }
    if (packet.type === 'heartbeat') {
      health.heartbeat();
      writeHealth();
      return;
    }
    if (packet.type === 'poll-success') {
      const wasOnline = health.snapshot().polling === 'online';
      health.pollSucceeded();
      clearTimeout(startupTimer);
      if (!wasOnline) {
        console.log('[Guardian] Polling con Telegram establecido y activo.');
        recordStatus('polling', 'online', randomUUID());
      }
      return;
    }
    if (packet.type === 'update-success') {
      health.updateSucceeded();
      return;
    }
    if (packet.type === 'polling-stopped') {
      if (!intentionalShutdown && !fatal && !replacingWorker) fatalShutdown('polling-ended');
      else health.markWorkerStopped();
      return;
    }
    if (packet.type === 'fatal') {
      console.error(`[Guardian] Worker reportó error fatal: ${packet.reason}`);
      fatalShutdown(packet.reason);
      return;
    }
  }

  function spawnWorker() {
    if (fatal || intentionalShutdown || worker) return;
    workerGeneration += 1;
    workerCapability = randomCapability();
    workerStopping = false;
    console.log(`[Guardian] Iniciando bot worker (generación ${workerGeneration})...`);
    const workerData = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      generation: workerGeneration,
      capability: workerCapability,
      ...(testScenario ? { testScenario } : {})
    };
    try {
      worker = new Worker(getOwnedWorkerUrl(), { workerData, stdout: true, stderr: true });
    } catch {
      fatalShutdown('startup-failed');
      return;
    }
    let capturedOutputBytes = 0;
    const drain = (stream, target) => stream?.on('data', (chunk) => {
      capturedOutputBytes = Math.min(64 * 1024, capturedOutputBytes + chunk.length);
      try { target?.write(chunk); } catch {}
    });
    drain(worker.stdout, process.stdout);
    drain(worker.stderr, process.stderr);
    const expectedGeneration = workerGeneration;
    const expectedCapability = workerCapability;
    worker.on('message', (packet) => handleWorkerMessage(packet, expectedGeneration, expectedCapability));
    worker.once('error', () => fatalShutdown('worker-error'));
    worker.once('exit', (code) => {
      if (workerStopping || intentionalShutdown || fatal || replacingWorker) return;
      worker = null;
      health.markWorkerMissing();
      recordStatus('startup', 'failed');
      if (code !== 0) fatalShutdown('worker-error');
      else fatalShutdown('polling-ended');
    });
    startupTimer = setTimeout(() => {
      if (health.snapshot().polling !== 'online') fatalShutdown('startup-failed');
    }, startupTimeoutMs);
    startupTimer.unref?.();
  }

  pollTimer = setInterval(() => {
    const state = health.snapshot();
    if (state.workerStatus === 'running'
      && state.lastSuccessfulPollAt
      && Date.now() - Date.parse(state.lastSuccessfulPollAt) > 150_000) {
      fatalShutdown('polling-failed');
    }
  }, 5_000);
  healthTimer = setInterval(writeHealth, 5_000);
  pollTimer.unref?.();
  healthTimer.unref?.();
  writeHealth();
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('uncaughtException', () => fatalShutdown('worker-error'));
  process.once('unhandledRejection', () => fatalShutdown('worker-error'));
  spawnWorker();
  return {
    close: () => gracefulShutdown('close'),
    snapshot: () => health.snapshot(),
    getOwnedWorkerUrl
  };
}
