import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startGuardian } from './runtime/guardian.js';

export { startGuardian };

async function startFromEntrypoint() {
  await import('dotenv/config');
  startGuardian();
}

function isDirectExecution() {
  if (process.env.pm_exec_path) {
    try {
      if (pathToFileURL(resolve(process.env.pm_exec_path)).href === import.meta.url) {
        return true;
      }
    } catch {}
  }
  if (process.env.pm_id !== undefined) {
    return true;
  }
  const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
  return invokedPath === import.meta.url;
}

if (isDirectExecution()) {
  void startFromEntrypoint().catch(() => {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 5_000).unref?.();
  });
}
