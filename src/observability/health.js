import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { operationalDirectory } from './events.js';

const HEALTH_FILE = 'health.json';
const MAX_HEALTH_BYTES = 8 * 1024;
const HEALTH_HASH = /^[a-f0-9]{7,40}$/i;

function safeSha(value) {
  return typeof value === 'string' && HEALTH_HASH.test(value) ? value : 'unknown';
}

export function deriveHealth(snapshot, now = Date.now()) {
  const workerStatus = ['starting', 'ready', 'running', 'stopped', 'missing', 'failed'].includes(snapshot?.workerStatus)
    ? snapshot.workerStatus
    : 'missing';
  const heartbeatAt = Date.parse(snapshot?.lastWorkerHeartbeatAt || '');
  const pollAt = Date.parse(snapshot?.lastSuccessfulPollAt || '');
  let polling;
  if (workerStatus === 'stopped') polling = 'stopped';
  else if (workerStatus === 'missing' || workerStatus === 'failed') polling = 'missing';
  else if (!Number.isFinite(heartbeatAt) || !Number.isFinite(pollAt)) polling = 'missing';
  else if (now - heartbeatAt > 30_000 || now - pollAt > 150_000) polling = 'stale';
  else if (workerStatus === 'starting' || workerStatus === 'ready') polling = 'starting';
  else polling = 'online';

  return {
    status: polling === 'online' ? 'online' : polling,
    polling,
    workerStatus,
    lastWorkerHeartbeatAt: Number.isFinite(heartbeatAt) ? new Date(heartbeatAt).toISOString() : null,
    lastSuccessfulPollAt: Number.isFinite(pollAt) ? new Date(pollAt).toISOString() : null,
    lastUpdateAt: Number.isFinite(Date.parse(snapshot?.lastUpdateAt || ''))
      ? new Date(Date.parse(snapshot.lastUpdateAt)).toISOString()
      : null,
    deploymentSha: safeSha(snapshot?.deploymentSha),
    updatedAt: Number.isFinite(Date.parse(snapshot?.updatedAt || ''))
      ? new Date(Date.parse(snapshot.updatedAt)).toISOString()
      : null
  };
}

export function createHealthTracker({ deploymentSha, now = () => Date.now() } = {}) {
  let workerStatus = 'starting';
  let lastWorkerHeartbeatAt = null;
  let lastSuccessfulPollAt = null;
  let lastUpdateAt = null;

  return {
    markWorkerReady() { workerStatus = 'ready'; },
    markWorkerRunning() { workerStatus = 'running'; },
    markWorkerStopped() { workerStatus = 'stopped'; },
    markWorkerMissing() { workerStatus = 'missing'; },
    markWorkerFailed() { workerStatus = 'failed'; },
    heartbeat() { lastWorkerHeartbeatAt = new Date(now()).toISOString(); },
    pollSucceeded() {
      lastSuccessfulPollAt = new Date(now()).toISOString();
      workerStatus = 'running';
    },
    updateSucceeded() { lastUpdateAt = new Date(now()).toISOString(); },
    snapshot() {
      return deriveHealth({
        workerStatus,
        lastWorkerHeartbeatAt,
        lastSuccessfulPollAt,
        lastUpdateAt,
        deploymentSha: safeSha(deploymentSha),
        updatedAt: new Date(now()).toISOString()
      }, now());
    }
  };
}

export async function writeHealthSnapshot(snapshot, directory = operationalDirectory()) {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, HEALTH_FILE);
  const temporary = path.join(directory, `.health-${randomUUID()}.tmp`);
  const safe = deriveHealth(snapshot);
  try {
    await writeFile(temporary, JSON.stringify(safe), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function readHealthSnapshot(directory = operationalDirectory()) {
  const filePath = path.join(directory, HEALTH_FILE);
  const contents = await readFile(filePath, 'utf8').catch(() => null);
  if (contents === null || Buffer.byteLength(contents) > MAX_HEALTH_BYTES) {
    return deriveHealth({ workerStatus: 'missing', deploymentSha: 'unknown' });
  }
  try {
    return deriveHealth(JSON.parse(contents));
  } catch {
    return deriveHealth({ workerStatus: 'missing', deploymentSha: 'unknown' });
  }
}
