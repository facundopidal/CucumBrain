import { createTurnContext } from './turn-context.js';

export const IPC_PROTOCOL_VERSION = 1;

export const LIFECYCLE_BUDGETS = Object.freeze({
  admissionMs: 2_000,
  totalMs: 70_000,
  notificationMs: 3_000,
  cleanupMs: 5_000,
  audioDownloadMs: 10_000,
  audioBytes: 10 * 1024 * 1024,
  transcriptionMs: 20_000,
  consolidationMs: 8_000,
  llmMs: 15_000,
  toolMs: 5_000,
  maxProviderAttempts: 6,
  maxRetriesPerModel: 1,
  maxBackoffMs: 2_000
});

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'
]);

export function createRequestContext(options = {}) {
  return createTurnContext({ budgetMs: LIFECYCLE_BUDGETS.totalMs, ...options });
}

export function isRetryableDependencyError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.code);
  if (status === 429 || status >= 500) return true;
  if (typeof error?.code === 'string' && TRANSIENT_NETWORK_CODES.has(error.code)) return true;
  return error?.name === 'FetchError' || error?.name === 'TypeError' && /fetch|network/i.test(error.message || '');
}

export function waitAbortable(context, delayMs) {
  context.assertActive();
  const delay = Math.max(0, Math.min(delayMs, context.remainingMs));
  if (delay === 0) return Promise.reject(new Error('Lifecycle budget exhausted'));

  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, context.signal.reason || new Error('Lifecycle cancelled'));
    const timer = setTimeout(() => finish(resolve), delay);
    context.signal.addEventListener('abort', onAbort, { once: true });
  });
}
