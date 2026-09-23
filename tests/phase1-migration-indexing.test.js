import assert from 'assert';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { extractPathMetadata } from '../src/database/indexer.js';
import { runMigrations } from '../src/database/db.js';

console.log('=== TEST FASE 1: Migración de Base de Datos y Extracción de Metadata de Rutas ===');

// 1. Probar extractPathMetadata
console.log('\n--- Probando extractPathMetadata ---');
const baseVault = 'C:/test-vault';

const testCases = [
  {
    path: 'C:/test-vault/proyectos/TaPeer/Arquitectura.md',
    expected: { project: 'TaPeer', folder: 'proyectos/TaPeer' }
  },
  {
    path: 'C:/test-vault/Proyectos/CucumBrain/agent/tools.md',
    expected: { project: 'CucumBrain', folder: 'Proyectos/CucumBrain/agent' }
  },
  {
    path: 'C:/test-vault/proyectos/index.md',
    expected: { project: null, folder: 'proyectos' }
  },
  {
    path: 'C:/test-vault/limbo/idea-automatizacion.md',
    expected: { project: null, folder: 'limbo' }
  },
  {
    path: 'C:/test-vault/Libros/Clean Code.md',
    expected: { project: null, folder: 'Libros' }
  },
  {
    path: 'C:/test-vault/NotaRapida.md',
    expected: { project: null, folder: '.' }
  }
];

for (const tc of testCases) {
  const result = extractPathMetadata(tc.path, baseVault);
  assert.strictEqual(result.project, tc.expected.project, `Proyecto incorrecto para ${tc.path}`);
  assert.strictEqual(result.folder, tc.expected.folder, `Folder incorrecto para ${tc.path}`);
  console.log(`✅ OK: ${tc.path} -> project: ${result.project}, folder: ${result.folder}`);
}

// 2. Probar runMigrations en SQLite en memoria
console.log('\n--- Probando runMigrations e Idempotencia ---');
const testDb = new Database(':memory:');

// Crear esquema heredado (sin folder ni project)
testDb.prepare(`
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    file_path TEXT UNIQUE,
    title TEXT NOT NULL,
    type_id TEXT,
    status TEXT DEFAULT 'incubating',
    importance INTEGER DEFAULT 3,
    content TEXT,
    created_at TEXT,
    updated_at TEXT
  )
`).run();

// Primera ejecución de migración
runMigrations(testDb);

let columns = testDb.pragma('table_info(notes)');
let columnNames = columns.map(c => c.name);
assert(columnNames.includes('folder'), 'Columna folder no fue agregada');
assert(columnNames.includes('project'), 'Columna project no fue agregada');
console.log('✅ Columnas folder y project creadas correctamente.');

// Verificar índices
const indexes = testDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_notes_project', 'idx_notes_folder')").all();
assert.strictEqual(indexes.length, 2, 'Deben existir 2 índices para project y folder');
console.log('✅ Índices idx_notes_project y idx_notes_folder verificados.');

// Segunda ejecución de migración (Idempotencia)
runMigrations(testDb);
columns = testDb.pragma('table_info(notes)');
assert.strictEqual(columns.filter(c => c.name === 'folder').length, 1, 'No deben duplicarse columnas');
assert.strictEqual(columns.filter(c => c.name === 'project').length, 1, 'No deben duplicarse columnas');
console.log('✅ Idempotencia de migración verificada con éxito.');

testDb.close();

console.log('\n🎉 ¡TODOS LOS TESTS DE LA FASE 1 PASARON EXITOSAMENTE!');
