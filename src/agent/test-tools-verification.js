import 'dotenv/config';
import { askAgent } from './agent.js';
import db from '../database/db.js';
import fs from 'fs';
import path from 'path';

const NOTES_PATH = process.env.NOTES_PATH 
  ? path.resolve(process.env.NOTES_PATH) 
  : path.resolve('./vault');

async function run() {
  console.log('=== Iniciando Test de Verificación de Tools (Fase 3) ===');

  // Limpiar cualquier nota previa de prueba para no contaminar
  const testFiles = ['TestNota1.md', 'TestNota2.md'];
  for (const file of testFiles) {
    const filePath = path.join(NOTES_PATH, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  
  // Limpiar la base de datos de los registros de prueba correspondientes
  db.prepare('DELETE FROM notes WHERE id IN (?, ?)').run('testnota1', 'testnota2');
  db.prepare('DELETE FROM chat_history').run();
  
  console.log('🧹 Limpieza completada.');

  // --- PRUEBA 1: Crear una nota mediante interacción de lenguaje natural (Tool: createNote) ---
  console.log('\n--- Paso 1: Solicitando creación de nota a la IA ---');
  const q1 = 'Crea una nota con título "TestNota1" y que de contenido tenga "Esta es una nota creada de prueba para verificar las herramientas."';
  console.log(`Usuario: "${q1}"`);
  
  const a1 = await askAgent(q1);
  console.log(`Cerebro: "${a1.trim()}"`);

  // Verificar que la nota física se haya creado y esté en la base de datos
  const note1Path = path.join(NOTES_PATH, 'TestNota1.md');
  const fileExists1 = fs.existsSync(note1Path);
  console.log(`📁 ¿Archivo físico creado?: ${fileExists1}`);
  
  if (fileExists1) {
    const dbRecord = db.prepare('SELECT * FROM notes WHERE id = ?').get('testnota1');
    console.log('💾 Registro indexado en SQLite:', dbRecord);
  }

  // --- PRUEBA 2: Modificar la nota mediante lenguaje natural (Tool: appendNoteContent) ---
  console.log('\n--- Paso 2: Solicitando añadir contenido a la nota ---');
  const q2 = 'Agrega el texto "\\nEste es un texto extra añadido al final." a la nota "TestNota1".';
  console.log(`Usuario: "${q2}"`);
  
  const a2 = await askAgent(q2);
  console.log(`Cerebro: "${a2.trim()}"`);

  // Verificar el contenido del archivo físico
  if (fileExists1) {
    const fileContent = fs.readFileSync(note1Path, 'utf-8');
    console.log('📝 Contenido final del archivo físico:\n' + fileContent);
  }

  // --- PRUEBA 3: Conectar dos notas mediante WikiLinks (Tool: connectNotes) ---
  console.log('\n--- Paso 3: Creando nota destino y enlazándola ---');
  
  // Crear nota 2 directamente por herramienta
  console.log('Creando nota "TestNota2" físicamente...');
  const q3_init = 'Crea una nota llamada "TestNota2" con contenido "Nota destino de prueba."';
  await askAgent(q3_init);

  const q3 = 'Conecta la nota "TestNota1" con la nota "TestNota2".';
  console.log(`Usuario: "${q3}"`);
  
  const a3 = await askAgent(q3);
  console.log(`Cerebro: "${a3.trim()}"`);

  // Verificar WikiLink en el archivo de origen
  if (fileExists1) {
    const fileContent = fs.readFileSync(note1Path, 'utf-8');
    console.log('📝 Contenido de TestNota1 después del enlace:\n' + fileContent);
    
    // Verificar relaciones en la base de datos
    const relations = db.prepare('SELECT * FROM note_relations').all();
    console.log('🔗 Relaciones indexadas en SQLite:', relations);
  }

  // --- PRUEBA 4: Listar notas (Tool: listNotes) ---
  console.log('\n--- Paso 4: Solicitando listar las notas ---');
  const q4 = '¿Qué notas tienes registradas actualmente en tu sistema? Dime los nombres de las que hay.';
  console.log(`Usuario: "${q4}"`);
  
  const a4 = await askAgent(q4);
  console.log(`Cerebro: "${a4.trim()}"`);
}

run().catch(console.error);
