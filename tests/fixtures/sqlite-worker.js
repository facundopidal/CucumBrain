import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const database = new Database(workerData.databasePath);
database.exec('CREATE TABLE worker_probe (value TEXT NOT NULL)');
database.prepare('INSERT INTO worker_probe (value) VALUES (?)').run('worker-ready');
const row = database.prepare('SELECT value FROM worker_probe').get();
database.close();
parentPort.postMessage(row);
