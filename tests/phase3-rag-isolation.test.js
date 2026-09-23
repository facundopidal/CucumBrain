import assert from 'assert';
import Database from 'better-sqlite3';
import { searchNotes, detectActiveProject } from '../src/agent/agent.js';
import db from '../src/database/db.js';

console.log('=== TEST FASE 3: Aislamiento de RAG y Detección de Proyectos ===');

// Preparar datos en SQLite para la prueba
db.prepare('DELETE FROM notes WHERE id LIKE ?').run('test-rag-%');

const insertStmt = db.prepare(`
  INSERT INTO notes (id, file_path, title, type_id, status, importance, content, folder, project)
  VALUES (?, ?, ?, 'idea', 'active', ?, ?, ?, ?)
`);

// 1. Nota de TaPeer que menciona "whatsapp"
insertStmt.run(
  'test-rag-tapeer',
  'C:/mock/proyectos/TaPeer/WhatsAppIntegration.md',
  'WhatsAppIntegration',
  4,
  'Integración de WhatsApp para TaPeer mediante API oficial',
  'proyectos/TaPeer',
  'TaPeer'
);

// 2. Nota de MultiWhatsApp que menciona "whatsapp"
insertStmt.run(
  'test-rag-multiwhatsapp',
  'C:/mock/proyectos/MultiWhatsApp/Architecture.md',
  'Architecture WhatsApp',
  5,
  'Arquitectura multiempresa de WhatsApp con microservicios',
  'proyectos/MultiWhatsApp',
  'MultiWhatsApp'
);

// 3. Nota transversal en limbo que menciona "whatsapp"
insertStmt.run(
  'test-rag-limbo',
  'C:/mock/limbo/MetaApiNotes.md',
  'MetaApiNotes',
  5,
  'Apuntes generales sobre Meta WhatsApp API y webhooks',
  'limbo',
  null
);

try {
  // PRUEBA 1: Búsqueda con activeProject = 'TaPeer'
  console.log('\n--- Probando searchNotes con activeProject="TaPeer" ---');
  const resultsTaPeer = searchNotes('whatsapp', 'TaPeer');
  const idsTaPeer = resultsTaPeer.map(r => r.id);

  console.log('Notas encontradas:', idsTaPeer);
  assert(idsTaPeer.includes('test-rag-tapeer'), 'Debe incluir la nota de TaPeer');
  assert(idsTaPeer.includes('test-rag-limbo'), 'Debe incluir la nota transversal de limbo');
  assert(!idsTaPeer.includes('test-rag-multiwhatsapp'), 'DEBE SUPRIMIR estrictamente la nota de MultiWhatsApp');
  console.log('✅ Aislamiento estricto verificado: la nota de MultiWhatsApp fue excluida.');

  // PRUEBA 2: Búsqueda sin activeProject (transversal)
  console.log('\n--- Probando searchNotes sin activeProject (global) ---');
  const resultsGlobal = searchNotes('whatsapp', null);
  const idsGlobal = resultsGlobal.map(r => r.id);

  console.log('Notas encontradas en global:', idsGlobal);
  assert(idsGlobal.includes('test-rag-tapeer'), 'Debe incluir nota de TaPeer');
  assert(idsGlobal.includes('test-rag-multiwhatsapp'), 'Debe incluir nota de MultiWhatsApp');
  assert(idsGlobal.includes('test-rag-limbo'), 'Debe incluir nota de limbo');
  console.log('✅ Búsqueda global sin activeProject incluye todas las notas relevantes.');

  // PRUEBA 3: Detección de proyecto activo en mensaje
  console.log('\n--- Probando detectActiveProject ---');
  const detected1 = detectActiveProject('¿Cómo conectamos el bot en TaPeer?', []);
  assert.strictEqual(detected1?.toLowerCase(), 'tapeer', 'Debió detectar TaPeer en el mensaje');
  console.log(`✅ detectActiveProject detectó: "${detected1}" desde el mensaje.`);

  // PRUEBA 4: Detección de proyecto activo en historial reciente
  const history = [
    { role: 'user', content: 'Hablemos de TaPeer y su arquitectura' },
    { role: 'assistant', content: 'Entendido, cuéntame qué dudas tienes sobre TaPeer.' }
  ];
  const detected2 = detectActiveProject('¿Cuáles son los endpoints principales?', history);
  assert.strictEqual(detected2?.toLowerCase(), 'tapeer', 'Debió detectar TaPeer desde el historial reciente');
  console.log(`✅ detectActiveProject detectó: "${detected2}" desde el historial reciente.`);

  // PRUEBA 5: No detección cuando no hay menciones
  const detected3 = detectActiveProject('Quiero anotar una idea sobre recetas de cocina', []);
  assert.strictEqual(detected3, null, 'No debe detectar ningún proyecto');
  console.log('✅ detectActiveProject devolvió null para consulta genérica.');

} finally {
  db.prepare('DELETE FROM notes WHERE id LIKE ?').run('test-rag-%');
}

console.log('\n🎉 ¡TODOS LOS TESTS DE LA FASE 3 PASARON EXITOSAMENTE!');
