import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../../database.sqlite');

export function runMigrations(database) {
  // Verificar si existe la tabla notes antes de intentar migrar
  const tableCheck = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get();
  if (!tableCheck) {
    return;
  }

  const columns = database.pragma('table_info(notes)');
  const columnNames = new Set(columns.map(c => c.name));

  if (!columnNames.has('folder')) {
    database.prepare('ALTER TABLE notes ADD COLUMN folder TEXT').run();
    console.log('[Migration] Columna "folder" agregada a la tabla notes.');
  }
  if (!columnNames.has('project')) {
    database.prepare('ALTER TABLE notes ADD COLUMN project TEXT').run();
    console.log('[Migration] Columna "project" agregada a la tabla notes.');
  }

  database.prepare('CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project)').run();
  database.prepare('CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder)').run();
}

// Backup automático de la base de datos previo a migraciones
if (fs.existsSync(dbPath)) {
  try {
    fs.copyFileSync(dbPath, `${dbPath}.bak`);
    console.log('[DB] Backup automático creado en database.sqlite.bak');
  } catch (err) {
    console.warn('[DB] No se pudo crear backup de la base de datos:', err.message);
  }
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

runMigrations(db);

export default db;
