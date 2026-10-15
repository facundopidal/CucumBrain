import { createServer } from 'node:http';
import { EVENT_LIMITS, operationalDirectory, readOperationalEvents } from './events.js';
import { readHealthSnapshot } from './health.js';

const IDENTITY_HEADER = 'tailscale-user-login';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s,<>]+@[^@\s,<>]+$/;
const STAGES = new Set([
  'startup', 'admission', 'download', 'transcription', 'consolidation',
  'llm', 'tool', 'note_write', 'history_write', 'memory_write',
  'index_update', 'telegram_send', 'polling', 'cleanup', 'viewer'
]);
const STATUSES = new Set([
  'started', 'completed', 'failed', 'cancelled', 'timed_out', 'stopped',
  'online', 'stale', 'missing', 'unknown', 'rejected', 'unconfigured', 'ready'
]);
const MAX_QUERY_MS = 2_000;
const MAX_EVENTS_BYTES = EVENT_LIMITS.maxResponseBytes;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function validIdentity(identity) {
  return typeof identity === 'string'
    && identity.length <= 254
    && EMAIL.test(identity)
    && !/^tag:/i.test(identity)
    && !/[\u0000-\u001f\u007f]/.test(identity);
}

export function authorizeRequest(request, allowedIdentities = []) {
  if (!Array.isArray(allowedIdentities) || allowedIdentities.length === 0) return false;
  if (allowedIdentities.some((identity) => !validIdentity(identity))) return false;
  if (new Set(allowedIdentities).size !== allowedIdentities.length) return false;

  const rawHeaders = Array.isArray(request?.rawHeaders) ? request.rawHeaders : [];
  const matches = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === IDENTITY_HEADER) {
      matches.push(String(rawHeaders[index + 1]));
    }
  }
  if (matches.length !== 1) return false;
  const identity = matches[0];
  if (!validIdentity(identity)) return false;
  return allowedIdentities.includes(identity);
}

function responseHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
  };
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_EVENTS_BYTES) {
    body = JSON.stringify({ error: 'response_limit_exceeded' });
    statusCode = 413;
  }
  response.writeHead(statusCode, {
    ...responseHeaders('application/json; charset=utf-8'),
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  response.end(body);
}

function boundedQuery(filters, timeoutMs = MAX_QUERY_MS) {
  let timeout;
  return Promise.race([
    Promise.resolve().then(() => filters()),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('viewer query timed out')), timeoutMs);
      timeout.unref?.();
    })
  ]).finally(() => clearTimeout(timeout));
}

function parseEventFilters(url) {
  const allowed = new Set(['limit', 'stage', 'status', 'after', 'before', 'requestId']);
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1 || value.length > 128) return null;
  }
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_LIMITS.maxRecords) return null;
  const stage = url.searchParams.get('stage');
  const status = url.searchParams.get('status');
  if (stage && !STAGES.has(stage)) return null;
  if (status && !STATUSES.has(status)) return null;
  const requestId = url.searchParams.get('requestId');
  if (requestId && !UUID.test(requestId)) return null;
  const afterText = url.searchParams.get('after');
  const beforeText = url.searchParams.get('before');
  const after = afterText === null ? undefined : Date.parse(afterText);
  const before = beforeText === null ? undefined : Date.parse(beforeText);
  if ((afterText !== null && !Number.isFinite(after)) || (beforeText !== null && !Number.isFinite(before))) return null;
  if (after !== undefined && before !== undefined && after > before) return null;
  return { limit, stage: stage || undefined, status: status || undefined, requestId: requestId || undefined, after, before };
}

function renderHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CucumBrain operations</title>
<style>body{font:16px system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#18212b}main{display:grid;gap:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:1rem;border-radius:.5rem}label{margin-right:1rem}button{padding:.5rem 1rem}</style></head>
<body><main><h1>Operational status</h1><p id="health">Loading status…</p><form id="filters"><label>Stage <select name="stage"><option value="">All</option><option>startup</option><option>admission</option><option>download</option><option>transcription</option><option>consolidation</option><option>llm</option><option>tool</option><option>index_update</option><option>telegram_send</option><option>polling</option></select></label><label>Status <select name="status"><option value="">All</option><option>started</option><option>completed</option><option>failed</option><option>cancelled</option><option>timed_out</option><option>stopped</option><option>online</option><option>stale</option><option>missing</option></select></label><button type="submit">Refresh</button></form><pre id="events" aria-live="polite">No events loaded.</pre></main>
<script>
const health=document.getElementById('health');const events=document.getElementById('events');const form=document.getElementById('filters');
async function refresh(){try{const h=await fetch('/health',{cache:'no-store'});const hs=await h.json();health.textContent='Polling: '+hs.polling+' | Worker: '+hs.workerStatus+' | Deployment SHA: '+hs.deploymentSha;const query=new URLSearchParams(new FormData(form));query.set('limit','200');const r=await fetch('/events?'+query.toString(),{cache:'no-store'});const body=await r.json();events.textContent=JSON.stringify(body.events||body,null,2)}catch{health.textContent='Operational status is temporarily unavailable.';events.textContent='No event data available.'}}
form.addEventListener('submit',event=>{event.preventDefault();void refresh()});void refresh();
</script></body></html>`;
}

export function renderEventsHtml() {
  return renderHtml();
}

export function createViewerServer({
  allowedIdentities = [],
  eventReader = (filters) => readOperationalEvents({ directory: operationalDirectory(), filters }),
  healthReader = () => readHealthSnapshot(operationalDirectory())
} = {}) {
  const allowed = [...allowedIdentities];
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return;
    }
    if (!authorizeRequest(request, allowed)) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }

    let url;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    if (url.pathname === '/' && url.search === '') {
      const body = renderHtml();
      response.writeHead(200, {
        ...responseHeaders('text/html; charset=utf-8'),
        'Content-Length': Buffer.byteLength(body)
      });
      response.end(body);
      return;
    }
    if (url.pathname === '/health' && url.search === '') {
      try {
        const health = await boundedQuery(() => healthReader());
        sendJson(response, 200, health);
      } catch {
        sendJson(response, 503, { error: 'health_unavailable' });
      }
      return;
    }
    if (url.pathname === '/events') {
      const filters = parseEventFilters(url);
      if (!filters) {
        sendJson(response, 400, { error: 'invalid_filters' });
        return;
      }
      try {
        const events = await boundedQuery(() => eventReader(filters));
        const safeEvents = Array.isArray(events) ? events.slice(0, filters.limit) : [];
        sendJson(response, 200, { events: safeEvents });
      } catch {
        sendJson(response, 503, { error: 'events_unavailable' });
      }
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });

  server.maxConnections = 16;
  server.maxHeadersCount = 16;
  server.headersTimeout = 2_000;
  server.requestTimeout = 2_000;
  server.keepAliveTimeout = 1_000;
  return server;
}
