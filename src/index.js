import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startGuardian } from './runtime/guardian.js';

export { startGuardian };

async function startFromEntrypoint() {
  await import('dotenv/config');
  startGuardian();
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  void startFromEntrypoint().catch(() => {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 5_000).unref?.();
  });
}
