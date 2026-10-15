import 'dotenv/config';
import { createEventStore, operationalDirectory } from './events.js';
import { createViewerServer } from './viewer.js';
import { readHealthSnapshot } from './health.js';

const identities = (process.env.OBSERVABILITY_ALLOWED_IDENTITIES || '')
  .split(',')
  .map((identity) => identity.trim())
  .filter(Boolean);
const store = createEventStore({ directory: operationalDirectory() });
const server = createViewerServer({
  allowedIdentities: identities,
  eventReader: (filters) => store.read(filters),
  healthReader: () => readHealthSnapshot(operationalDirectory())
});
const port = Number(process.env.OBSERVABILITY_PORT) || 4173;

server.listen(port, '127.0.0.1');
server.on('error', () => {
  process.exitCode = 1;
});

const stop = () => {
  server.close();
  void store.close().finally(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
