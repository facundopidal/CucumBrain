import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Guardamos la DB en la raíz del proyecto
const dbPath = path.resolve(__dirname, '../../database.sqlite'); 

const db = new Database(dbPath, { verbose: console.log });

// Enable Foreign Keys (crítico en SQLite)
db.pragma('foreign_keys = ON');

console.log('Inicializando la base de datos de CucumBrain...');

// 1. Tabla de Tipos (Soporta categorías dinámicas creadas por vos o la IA)
db.prepare(`
  CREATE TABLE IF NOT EXISTS types (
    id TEXT PRIMARY KEY,
    created_by TEXT DEFAULT 'user' -- 'user' o 'ia-agent'
  )
`).run();

// Insertar tipos por defecto para la fase de inicio
const insertType = db.prepare(`INSERT OR IGNORE INTO types (id, created_by) VALUES (?, ?)`);
const defaultTypes = ['idea', 'project', 'coding-session', 'finance', 'resource', 'recipe', 'book'];
for (const type of defaultTypes) {
  insertType.run(type, 'user');
}

// 2. Tabla Principal de Notas (Guarda metadatos y contenido markdown indexado)
db.prepare(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,            -- Generado desde el YAML id o nombre del archivo
    file_path TEXT UNIQUE,          -- Ruta del archivo para sincronizar cambios/eliminaciones
    title TEXT NOT NULL,
    type_id TEXT,
    status TEXT DEFAULT 'incubating', -- 'active', 'paused', 'completed', 'archived'
    importance INTEGER DEFAULT 3,   -- Escala del 1 al 5
    content TEXT,                  -- Cuerpo en Markdown para búsquedas y contexto RAG
    created_at TEXT,
    updated_at TEXT,
    FOREIGN KEY(type_id) REFERENCES types(id) ON DELETE SET NULL
  )
`).run();

// 3. Tabla de Relaciones entre Notas (Para el Grafo de Obsidian)
db.prepare(`
  CREATE TABLE IF NOT EXISTS note_relations (
    origin_note_id TEXT,
    destination_note_id TEXT,
    PRIMARY KEY (origin_note_id, destination_note_id),
    FOREIGN KEY(origin_note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY(destination_note_id) REFERENCES notes(id) ON DELETE CASCADE
  )
`).run();

// 4. Tabla de Historial de Cambios (Monitorea la evolución de las notas)
db.prepare(`
  CREATE TABLE IF NOT EXISTS change_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT,
    modified_field TEXT,           -- 'type', 'status', 'importance'
    old_value TEXT,
    new_value TEXT,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
  )
`).run();

// 5. Tabla de Memoria a Largo Plazo (Seguimiento de entidades y variables de estado)
db.prepare(`
  CREATE TABLE IF NOT EXISTS long_term_memory (
    key TEXT PRIMARY KEY,          -- Ej: 'preferred_tech', 'brother_name'
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// 6. Tabla de Historial de Chat Reciente (Memoria de corto plazo)
db.prepare(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT CHECK(role IN ('user', 'assistant')), -- 'user' o 'assistant'
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// 7. Tabla de Resúmenes de Sesión (Consolidación de chat)
db.prepare(`
  CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

console.log('¡Base de datos de CucumBrain inicializada con éxito!');

db.close();
