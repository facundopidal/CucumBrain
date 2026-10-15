import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runWorker(worker, timeoutMs = 6_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Worker fixture timed out'));
    }, timeoutMs);
    worker.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Worker fixture exited with code ${code}`));
      }
    });
  });
}

test('installed better-sqlite3 loads and performs isolated work in an ESM worker', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cucumbrain-worker-db-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const worker = new Worker(new URL('./fixtures/sqlite-worker.js', import.meta.url), {
    workerData: { databasePath: path.join(directory, 'worker.sqlite') }
  });
  assert.deepEqual(await runWorker(worker), { value: 'worker-ready' });
});

test('the guardian accepts only fixed owned-worker messages and rejects stale generations', async () => {
  const { getOwnedWorkerUrl, validateWorkerPacket } = await import('../src/runtime/guardian.js');

  assert.ok(getOwnedWorkerUrl().pathname.endsWith('/src/runtime/bot-worker.js'));
  assert.equal(validateWorkerPacket({ type: 'load-module', module: 'file:///tmp/unsafe.js' }, 4, 'cap'), false);
  assert.equal(validateWorkerPacket({ protocolVersion: 1, type: 'heartbeat', generation: 3, capability: 'cap' }, 4, 'cap'), false);
  assert.equal(validateWorkerPacket({ protocolVersion: 1, type: 'heartbeat', generation: 4, capability: 'wrong' }, 4, 'cap'), false);
  assert.equal(validateWorkerPacket({ type: 'heartbeat', generation: 4, capability: 'cap' }, 4, 'cap'), false);
  assert.equal(validateWorkerPacket({ protocolVersion: 1, type: 'heartbeat', generation: 4, capability: 'cap' }, 4, 'cap'), true);
  assert.equal(validateWorkerPacket({ protocolVersion: 1, type: 'heartbeat', generation: 4, capability: 'cap', prompt: 'private' }, 4, 'cap'), false);
});

test('the executable entrypoint can be imported without starting a database, watcher, or bot', async () => {
  const entry = await import('../src/index.js?entrypoint-safety');
  assert.equal(typeof entry.startGuardian, 'function');
});

test('an effect already started may finish, but cancellation denies every later effect start', async () => {
  const { createTurnContext, startEffect } = await import('../src/runtime/turn-context.js');
  const context = createTurnContext({ generation: 12, budgetMs: 1_000 });
  let finishStartedEffect;
  let effectsStarted = 0;

  const alreadyStarted = startEffect(context, () => {
    effectsStarted += 1;
    return new Promise((resolve) => { finishStartedEffect = resolve; });
  });
  context.cancel('test-cancel');
  finishStartedEffect('late completion is allowed');

  assert.equal(await alreadyStarted, 'late completion is allowed');
  assert.throws(() => startEffect(context, () => {
    effectsStarted += 1;
  }), /cancel/i);
  assert.equal(effectsStarted, 1);
});

test('stage timeout terminalizes even when its operation never settles', async () => {
  const { createTurnContext } = await import('../src/runtime/turn-context.js');
  const context = createTurnContext({ generation: 13, budgetMs: 1_000 });
  const outcome = await Promise.race([
    context.runStage('tool', 20, () => new Promise(() => {}))
      .then(() => 'completed', (error) => error.reason || error.code),
    new Promise((resolve) => setTimeout(() => resolve('still-running'), 180))
  ]);

  assert.equal(outcome, 'stage-timeout');
  assert.equal(context.isActive(), true, 'a child-stage timeout must not cancel the whole turn');
});

test('lifecycle runtime caps retry/backoff budgets and makes waits abortable', async () => {
  const { createRequestContext, isRetryableDependencyError, LIFECYCLE_BUDGETS, waitAbortable } = await import('../src/runtime/lifecycle.js');
  assert.equal(LIFECYCLE_BUDGETS.admissionMs, 2_000);
  assert.equal(LIFECYCLE_BUDGETS.totalMs, 70_000);
  assert.equal(LIFECYCLE_BUDGETS.notificationMs, 3_000);
  assert.equal(LIFECYCLE_BUDGETS.cleanupMs, 5_000);
  assert.equal(LIFECYCLE_BUDGETS.maxProviderAttempts, 6);
  assert.equal(LIFECYCLE_BUDGETS.maxRetriesPerModel, 1);
  assert.equal(LIFECYCLE_BUDGETS.maxBackoffMs, 2_000);
  assert.equal(isRetryableDependencyError({ status: 429 }), true);
  assert.equal(isRetryableDependencyError({ status: 503 }), true);
  assert.equal(isRetryableDependencyError({ status: 401 }), false);

  const context = createRequestContext({ generation: 14, budgetMs: 100 });
  const backoff = waitAbortable(context, LIFECYCLE_BUDGETS.maxBackoffMs);
  setTimeout(() => context.cancel('test-cancel'), 5);
  await assert.rejects(backoff, (error) => error.code === 'TURN_CANCELLED');
});

async function runGuardianChild(t, { scenario, source, timeoutMs = 2_000 }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cucumbrain-guardian-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  let stdout = '';
  const env = {
    NODE_ENV: 'test',
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP
  };
  const scriptPath = path.join(directory, 'guardian-child.mjs');
  await writeFile(scriptPath, source, { encoding: 'utf8', flag: 'wx' });
  const child = spawn(process.execPath, [scriptPath], {
    cwd: directory,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let watchdog;
  let exit;
  try {
    exit = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`Guardian scenario ${scenario} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(watchdog);
  }
  let operational = '';
  try {
    const eventFile = (await readdir(path.join(directory, 'logs', 'operational'))).find((name) => name.startsWith('events-'));
    if (eventFile) operational = await readFile(path.join(directory, 'logs', 'operational', eventFile), 'utf8');
  } catch {}
  return { directory, stdout, stderr, exit, operational };
}

test('the owned worker path rejects stale and arbitrary-module IPC in live integration', async (t) => {
  const guardianUrl = pathToFileURL(path.join(repoRoot, 'src', 'runtime', 'guardian.js')).href;
  for (const scenario of ['stale-packet', 'arbitrary-module']) {
    const source = `
      import { startGuardian } from ${JSON.stringify(guardianUrl)};
      startGuardian({ testScenario: '${scenario}', startupTimeoutMs: 500, shutdownGraceMs: 250 });
    `;
    const { directory, exit } = await runGuardianChild(t, { scenario, source });
    assert.equal(exit[0], 1, `${scenario} must not make the worker online`);
    const eventFile = (await readdir(path.join(directory, 'logs', 'operational')))
      .find((name) => name.startsWith('events-'));
    assert.ok(eventFile, 'the guardian should record a sanitized rejection event');
    const contents = await readFile(path.join(directory, 'logs', 'operational', eventFile), 'utf8');
    assert.match(contents, /"status":"rejected"/);
    assert.doesNotMatch(contents, /unsafe\.js|module/);
  }
});

test('a valid cancellation acknowledgement releases admission without replacing the worker', async (t) => {
  const guardianUrl = pathToFileURL(path.join(repoRoot, 'src', 'runtime', 'guardian.js')).href;
  const source = `
    import { startGuardian } from ${JSON.stringify(guardianUrl)};
    const guardian = startGuardian({ testScenario: 'cancel-ack', startupTimeoutMs: 2_000, cleanupMs: 120, shutdownGraceMs: 100 });
    setTimeout(() => guardian.close(), 280);
  `;
  const { operational, exit } = await runGuardianChild(t, { scenario: 'cancel-ack', source });
  assert.equal(exit[0], 0);
  assert.match(operational, /"kind":"worker","stage":"admission","status":"completed"/);
  assert.doesNotMatch(operational, /"stage":"cleanup","status":"timed_out"/);
});

test('intentional shutdown exits successfully when the worker blocks cleanup', async (t) => {
  const guardianUrl = pathToFileURL(path.join(repoRoot, 'src', 'runtime', 'guardian.js')).href;
  const source = `
    import { startGuardian } from ${JSON.stringify(guardianUrl)};
    const guardian = startGuardian({ testScenario: 'cleanup-hang', startupTimeoutMs: 2_000, shutdownGraceMs: 80 });
    const ready = setInterval(() => {
      if (guardian.snapshot().workerStatus === 'ready') {
        clearInterval(ready);
        process.stdout.write('READY_SEEN\\n');
        guardian.close();
      }
    }, 5);
  `;
  const { exit, stderr, stdout, operational } = await runGuardianChild(t, { scenario: 'cleanup-hang', source, timeoutMs: 2_000 });
  assert.match(stdout, /READY_SEEN/);
  assert.equal(exit[1], null);
  assert.equal(exit[0], 0, `${stdout}\n${stderr}\n${operational}`);
});

test('a synchronous worker stall cannot hold guardian process shutdown beyond its grace', async (t) => {
  const guardianUrl = pathToFileURL(path.join(repoRoot, 'src', 'runtime', 'guardian.js')).href;
  const source = `
    import { startGuardian } from ${JSON.stringify(guardianUrl)};
    process.stdout.write('GUARDIAN_STARTED\\n');
    startGuardian({ testScenario: 'sync-stall', startupTimeoutMs: 300, shutdownGraceMs: 200 });
  `;
  const { stdout, operational, exit: [code, signal] } = await runGuardianChild(t, { scenario: 'sync-stall', source });
  assert.match(stdout, /GUARDIAN_STARTED/);
  assert.match(operational, /"status":"ready"/);
  assert.match(operational, /"status":"failed"/);
  assert.equal(signal, null);
  assert.notEqual(code, 0);
});

test('fatal polling classification distinguishes recoverable update failures', async () => {
  const { isFatalPollingError } = await import('../src/runtime/bot-worker.js');
  assert.equal(isFatalPollingError(Object.assign(new Error('handler failed'), { updateHandlerFailure: true })), false);
  assert.equal(isFatalPollingError(Object.assign(new Error('unauthorized'), { code: 401 })), true);
  assert.equal(isFatalPollingError(Object.assign(new Error('polling conflict'), { code: 409 })), true);
});

test('polling readiness follows a successful getUpdates call, never just worker launch', async () => {
  const { attachPollingReadiness } = await import('../src/runtime/bot-worker.js');
  const calls = [];
  let resolvePolling;
  let successfulPolls = 0;
  const bot = {
    telegram: {
      callApi(method, payload, options) {
        calls.push({ method, payload, options });
        if (method === 'getUpdates') return new Promise((resolve) => { resolvePolling = resolve; });
        return Promise.resolve({ ok: true });
      }
    }
  };
  attachPollingReadiness(bot, () => { successfulPolls += 1; });

  const polling = bot.telegram.callApi('getUpdates', { offset: 5 }, { signal: new AbortController().signal });
  assert.equal(successfulPolls, 0);
  assert.equal(calls[0].payload.timeout, 5);
  assert.equal(calls[0].payload.offset, 5);
  resolvePolling([]);
  await polling;
  assert.equal(successfulPolls, 1);

  await bot.telegram.callApi('getMe', {});
  assert.equal(successfulPolls, 1);
});

test('recoverable update-handler failure does not crash bot and allows subsequent updates', async (t) => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalAllowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  const { Telegram } = await import('telegraf');
  const originalCallApi = Telegram.prototype.callApi;
  Telegram.prototype.callApi = async () => ({ ok: true, result: { message_id: 1 } });

  t.after(() => {
    Telegram.prototype.callApi = originalCallApi;
    if (originalToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = originalToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (originalAllowed !== undefined) process.env.TELEGRAM_ALLOWED_USER_ID = originalAllowed;
    else delete process.env.TELEGRAM_ALLOWED_USER_ID;
  });

  process.env.TELEGRAM_BOT_TOKEN = '123456:TEST_TOKEN_FOR_LIFECYCLE';
  process.env.TELEGRAM_ALLOWED_USER_ID = '987654';

  const { createBotRuntime } = await import('../src/bot/bot.js');
  let updateSuccessCount = 0;
  const caughtErrors = [];
  let failFirst = true;

  const runtime = createBotRuntime({
    withRequestLifecycle: async (kind, operation) => {
      if (failFirst) {
        failFirst = false;
        throw new Error('transient lifecycle handler failure');
      }
      return operation(null);
    },
    onUpdate: () => { updateSuccessCount += 1; },
    onError: (err) => { caughtErrors.push(err); }
  });

  assert.ok(runtime.bot, 'bot runtime must be instantiated');

  const fakeUpdate1 = {
    update_id: 1,
    message: {
      message_id: 101,
      from: { id: 987654 },
      chat: { id: 987654 },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }]
    }
  };
  const fakeUpdate2 = {
    update_id: 2,
    message: {
      message_id: 102,
      from: { id: 987654 },
      chat: { id: 987654 },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }]
    }
  };

  // 1. Process failing update: caught by bot.catch, classified as updateHandlerFailure
  await runtime.bot.handleUpdate(fakeUpdate1);
  assert.equal(caughtErrors.length, 1);
  assert.equal(caughtErrors[0].updateHandlerFailure, true);
  assert.equal(updateSuccessCount, 0, 'failing update must not trigger onUpdate');

  // 2. Process subsequent update: succeeds and calls onUpdate
  await runtime.bot.handleUpdate(fakeUpdate2);
  assert.equal(caughtErrors.length, 1, 'no new errors should be caught');
  assert.equal(updateSuccessCount, 1, 'subsequent update must process successfully through the real bot path');
});

test('fatal polling failure leads to bounded guardian exit and fresh supervisor replacement', async (t) => {
  const guardianUrl = pathToFileURL(path.join(repoRoot, 'src', 'runtime', 'guardian.js')).href;

  // 1. Failing instance: worker signals fatal polling failure; guardian performs bounded exit with code 1
  const failSource = `
    import { startGuardian } from ${JSON.stringify(guardianUrl)};
    process.stdout.write('GUARDIAN_INSTANCE_1\\n');
    startGuardian({ testScenario: 'fatal-poll', startupTimeoutMs: 1_000, shutdownGraceMs: 250 });
  `;
  const { stdout: stdout1, exit: exit1, operational: op1 } = await runGuardianChild(t, { scenario: 'fatal-poll', source: failSource, timeoutMs: 3_500 });
  assert.match(stdout1, /GUARDIAN_INSTANCE_1/);
  assert.equal(exit1[0], 1, 'failing instance must exit with non-zero code');
  assert.match(op1, /"status":"failed"/, 'failing instance must record failure status');

  // 2. Supervisor replacement: fresh guardian instance starts and processes an update / reaches readiness
  const healthySource = `
    import { startGuardian } from ${JSON.stringify(guardianUrl)};
    process.stdout.write('GUARDIAN_INSTANCE_2\\n');
    const guardian = startGuardian({ testScenario: 'cancel-ack', startupTimeoutMs: 2_000, cleanupMs: 120, shutdownGraceMs: 100 });
    setTimeout(() => guardian.close(), 280);
  `;
  const { stdout: stdout2, exit: exit2, operational: op2 } = await runGuardianChild(t, { scenario: 'supervisor-replacement', source: healthySource, timeoutMs: 3_500 });
  assert.match(stdout2, /GUARDIAN_INSTANCE_2/);
  assert.equal(exit2[0], 0, 'replacement instance must succeed');
  assert.match(op2, /"kind":"worker","stage":"admission","status":"completed"/, 'replacement instance must process update / admission');
});
