import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('events reject unknown or content-bearing fields and drop safely at capacity', async (t) => {
  const { createEventStore } = await import('../src/observability/events.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cucumbrain-events-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = createEventStore({ directory, queueLimit: 1, maxBytesPerFile: 1_024, maxFiles: 2 });

  assert.equal(store.record({ kind: 'stage', stage: 'llm', status: 'started', prompt: 'private prompt' }), false);
  assert.equal(store.record({ kind: 'unknown', content: '<script>bad()</script>' }), false);
  assert.equal(store.record({ kind: 'stage', stage: 'llm', status: 'started' }), true);
  assert.equal(store.record({ kind: 'stage', stage: 'llm', status: 'completed' }), false);
  assert.equal(store.getDropCount(), 1);
  await store.flush();
  await store.close();
});

test('the viewer is loopback-only, read-only, exact-identity gated, and bounds query output', async (t) => {
  const { createViewerServer } = await import('../src/observability/viewer.js');
  const server = createViewerServer({
    allowedIdentities: ['operator@example.test'],
    eventReader: async () => Array.from({ length: 300 }, (_, index) => ({
      version: 1,
      requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      kind: 'stage',
      stage: 'llm',
      status: 'completed',
      durationMs: 10,
      timestamp: new Date().toISOString()
    })),
    healthReader: async () => ({ polling: 'stopped', deploymentSha: 'unknown' })
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  const denied = await fetch(`${url}/events`);
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${url}/events?limit=200`, { headers: { 'Tailscale-User-Login': 'operator@example.test' } });
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.ok(payload.events.length <= 200);
  assert.ok(Number(allowed.headers.get('content-length')) <= 256 * 1024);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');

  const methodDenied = await fetch(`${url}/health`, { method: 'POST', headers: { 'Tailscale-User-Login': 'operator@example.test' } });
  assert.equal(methodDenied.status, 405);
});

test('duplicate, tagged, unknown, and markup-like identities are rejected without content rendering', async () => {
  const { authorizeRequest, renderEventsHtml } = await import('../src/observability/viewer.js');
  const identities = ['operator@example.test'];
  assert.equal(authorizeRequest({ rawHeaders: ['Tailscale-User-Login', 'operator@example.test'] }, identities), true);
  assert.equal(authorizeRequest({ rawHeaders: ['Tailscale-User-Login', 'operator@example.test', 'Tailscale-User-Login', 'operator@example.test'] }, identities), false);
  assert.equal(authorizeRequest({ rawHeaders: ['Tailscale-User-Login', 'tag:admins'] }, identities), false);
  assert.equal(authorizeRequest({ rawHeaders: ['Tailscale-User-Login', 'other@example.test'] }, identities), false);

  const html = renderEventsHtml();
  assert.match(html, /textContent/);
  assert.doesNotMatch(html, /innerHTML/);
});
