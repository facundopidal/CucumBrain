import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, appendFile, unlink, open } from 'node:fs/promises';
import path from 'node:path';

const EVENT_KINDS = new Set(['request', 'stage', 'polling', 'worker', 'viewer']);
const STAGES = new Set([
  'startup', 'admission', 'download', 'transcription', 'consolidation',
  'llm', 'tool', 'note_write', 'history_write', 'memory_write',
  'index_update', 'telegram_send', 'polling', 'cleanup', 'viewer'
]);
const STATUSES = new Set([
  'started', 'completed', 'failed', 'cancelled', 'timed_out', 'stopped',
  'online', 'stale', 'missing', 'unknown', 'rejected', 'unconfigured', 'ready'
]);
const PROVIDERS = new Set(['gemini', 'groq', 'openrouter']);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const EVENT_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const EVENT_LIMITS = Object.freeze({
  maxBytesPerFile: MAX_EVENT_BYTES,
  maxFiles: 5,
  retentionDays: 7,
  queueLimit: 256,
  maxRecords: 200,
  maxResponseBytes: MAX_RESPONSE_BYTES
});

export function operationalDirectory(cwd = process.cwd()) {
  return path.resolve(cwd, 'logs', 'operational');
}

function sanitizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const allowed = new Set(['kind', 'stage', 'status', 'requestId', 'durationMs', 'attempt', 'provider', 'deploymentSha']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  if (!EVENT_KINDS.has(input.kind) || !STAGES.has(input.stage) || !STATUSES.has(input.status)) return null;

  const event = {
    version: 1,
    timestamp: new Date().toISOString(),
    requestId: REQUEST_ID.test(input.requestId || '') ? input.requestId : randomUUID(),
    kind: input.kind,
    stage: input.stage,
    status: input.status
  };
  if (input.durationMs !== undefined) {
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return null;
    event.durationMs = Math.min(Math.floor(input.durationMs), 24 * 60 * 60 * 1000);
  }
  if (input.attempt !== undefined) {
    if (!Number.isInteger(input.attempt) || input.attempt < 0 || input.attempt > 6) return null;
    event.attempt = input.attempt;
  }
  if (input.provider !== undefined) {
    if (!PROVIDERS.has(input.provider)) return null;
    event.provider = input.provider;
  }
  if (input.deploymentSha !== undefined) {
    if (typeof input.deploymentSha !== 'string' || !/^[a-f0-9]{7,40}$/i.test(input.deploymentSha)) return null;
    event.deploymentSha = input.deploymentSha;
  }
  return event;
}

function todayFileName(now = new Date()) {
  return `events-${now.toISOString().slice(0, 10)}.jsonl`;
}

export function createEventStore({
  directory = operationalDirectory(),
  queueLimit = EVENT_LIMITS.queueLimit,
  maxBytesPerFile = EVENT_LIMITS.maxBytesPerFile,
  maxFiles = EVENT_LIMITS.maxFiles,
  now = () => new Date()
} = {}) {
  const queue = [];
  const byteCounts = new Map();
  let inFlight = 0;
  let dropCount = 0;
  let closed = false;
  let pumping = false;
  let drainWaiters = [];

  const completeDrain = () => {
    if (queue.length === 0 && inFlight === 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  async function enforceRetention() {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      const match = EVENT_FILE.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const filePath = path.join(directory, entry.name);
      const fileStat = await stat(filePath).catch(() => null);
      if (fileStat) files.push({ filePath, name: entry.name, size: fileStat.size, date: match[1] });
    }
    files.sort((a, b) => b.date.localeCompare(a.date));
    const cutoff = new Date(now().getTime() - EVENT_LIMITS.retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const retained = new Set(files.filter((file, index) => index < maxFiles && file.date >= cutoff).map((file) => file.name));
    await Promise.all(files.filter((file) => !retained.has(file.name)).map((file) => unlink(file.filePath).catch(() => {})));
    for (const file of files) {
      if (!retained.has(file.name)) byteCounts.delete(file.name);
    }
  }

  async function writeEvent(event) {
    await mkdir(directory, { recursive: true });
    const name = todayFileName(now());
    const filePath = path.join(directory, name);
    let size = byteCounts.get(name);
    if (size === undefined) {
      size = (await stat(filePath).catch(() => ({ size: 0 }))).size;
    }
    const line = `${JSON.stringify(event)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > maxBytesPerFile || size + lineBytes > maxBytesPerFile) {
      dropCount += 1;
      return;
    }
    await appendFile(filePath, line, { encoding: 'utf8', flag: 'a' });
    byteCounts.set(name, size + lineBytes);
    await enforceRetention();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const event = queue.shift();
        inFlight += 1;
        try {
          await writeEvent(event);
        } catch {
          dropCount += 1;
        } finally {
          inFlight -= 1;
        }
      }
    } finally {
      pumping = false;
      completeDrain();
      if (queue.length) void pump();
    }
  }

  return {
    record(input) {
      if (closed || queue.length + inFlight >= queueLimit) {
        dropCount += 1;
        return false;
      }
      const event = sanitizeEvent(input);
      if (!event) return false;
      queue.push(event);
      void pump();
      return true;
    },
    getDropCount() {
      return dropCount;
    },
    async flush() {
      if (queue.length === 0 && inFlight === 0) return;
      await new Promise((resolve) => drainWaiters.push(resolve));
    },
    async close() {
      closed = true;
      await this.flush();
    },
    async read(filters = {}) {
      return readOperationalEvents({ directory, filters });
    }
  };
}

function matchesFilters(event, filters) {
  if (filters.stage && event.stage !== filters.stage) return false;
  if (filters.status && event.status !== filters.status) return false;
  if (filters.requestId && event.requestId !== filters.requestId) return false;
  const eventTime = Date.parse(event.timestamp);
  if (Number.isFinite(filters.after) && eventTime < filters.after) return false;
  if (Number.isFinite(filters.before) && eventTime > filters.before) return false;
  return true;
}

export async function readOperationalEvents({ directory = operationalDirectory(), filters = {} } = {}) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const fileEntries = entries
    .filter((entry) => entry.isFile() && EVENT_FILE.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, EVENT_LIMITS.maxFiles);
  const output = [];
  let outputBytes = 2;
  const limit = Math.max(1, Math.min(EVENT_LIMITS.maxRecords, Number(filters.limit) || 50));

  for (const entry of fileEntries) {
    const filePath = path.join(directory, entry.name);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat) continue;
    let content = '';
    if (fileStat.size <= EVENT_LIMITS.maxBytesPerFile) {
      content = await readFile(filePath, 'utf8').catch(() => '');
    } else {
      const handle = await open(filePath, 'r').catch(() => null);
      if (handle) {
        try {
          const buffer = Buffer.alloc(EVENT_LIMITS.maxBytesPerFile);
          const startPosition = Math.max(0, fileStat.size - EVENT_LIMITS.maxBytesPerFile);
          const { bytesRead } = await handle.read(buffer, 0, EVENT_LIMITS.maxBytesPerFile, startPosition);
          content = buffer.toString('utf8', 0, bytesRead);
        } catch {
          content = '';
        } finally {
          await handle.close().catch(() => {});
        }
      }
    }
    const records = content.split('\n').filter(Boolean).reverse();
    for (const line of records) {
      if (output.length >= limit) return output;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const sanitized = sanitizeStoredEvent(event);
      if (!sanitized || !matchesFilters(sanitized, filters)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(sanitized)) + 1;
      if (outputBytes + bytes > MAX_RESPONSE_BYTES) return output;
      output.push(sanitized);
      outputBytes += bytes;
    }
  }
  return output;
}

function sanitizeStoredEvent(input) {
  if (!input || input.version !== 1 || typeof input.timestamp !== 'string') return null;
  const sanitized = sanitizeEvent({
    kind: input.kind,
    stage: input.stage,
    status: input.status,
    requestId: input.requestId,
    durationMs: input.durationMs,
    attempt: input.attempt,
    provider: input.provider,
    deploymentSha: input.deploymentSha
  });
  if (!sanitized) return null;
  const timestamp = Date.parse(input.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  return { ...sanitized, timestamp: new Date(timestamp).toISOString() };
}
