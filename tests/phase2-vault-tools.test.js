import assert from 'assert';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

console.log('=== TEST FASE 2: Herramientas de Gestión de Carpetas y Bóveda ===');

// Mock environment and temp directory
const tempVaultDir = path.resolve('./temp/test-vault-phase2');
if (fs.existsSync(tempVaultDir)) {
  fs.rmSync(tempVaultDir, { recursive: true, force: true });
}
fs.mkdirSync(tempVaultDir, { recursive: true });

process.env.NOTES_PATH = tempVaultDir;

// Import tools and indexer after NOTES_PATH is set
const { toolActions, setActiveProjectContext } = await import('../src/agent/tools.js');
const db = (await import('../src/database/db.js')).default;

try {
  // 1. Probar createNote sin proyecto activo -> debe crearse en limbo/
  console.log('\n--- Probando createNote por defecto en limbo ---');
  setActiveProjectContext(null);
  const res1 = await toolActions.createNote({
    title: 'NotaDePruebaLimbo',
    content: 'Contenido en limbo'
  });
  assert(res1.success, `createNote falló: ${res1.error}`);
  const expectedLimboPath = path.join(tempVaultDir, 'limbo', 'NotaDePruebaLimbo.md');
  assert(fs.existsSync(expectedLimboPath), `El archivo no fue creado en limbo: ${expectedLimboPath}`);
  console.log('✅ createNote por defecto crea la nota en limbo/');

  // 2. Probar createNote con proyecto activo -> debe crearse en proyectos/<activeProject>
  console.log('\n--- Probando createNote con proyecto activo ---');
  setActiveProjectContext('TaPeer');
  const res2 = await toolActions.createNote({
    title: 'NotaDeTaPeer',
    content: 'Contenido de TaPeer'
  });
  assert(res2.success, `createNote falló: ${res2.error}`);
  const expectedTaPeerPath = path.join(tempVaultDir, 'proyectos', 'TaPeer', 'NotaDeTaPeer.md');
  assert(fs.existsSync(expectedTaPeerPath), `El archivo no fue creado en proyectos/TaPeer: ${expectedTaPeerPath}`);
  console.log('✅ createNote con proyecto activo crea la nota en proyectos/<activeProject>/');

  // 3. Probar listProjects
  console.log('\n--- Probando listProjects ---');
  const projRes = await toolActions.listProjects();
  assert(projRes.success, 'listProjects falló');
  const tapeerProj = projRes.projects.find(p => p.name.toLowerCase() === 'tapeer');
  assert(tapeerProj, 'No se encontró el proyecto TaPeer en listProjects');
  console.log('✅ listProjects detectó proyectos y conteos:', projRes.projects);

  // 4. Probar moveNote
  console.log('\n--- Probando moveNote de limbo a proyectos/TaPeer ---');
  const moveRes = await toolActions.moveNote({
    title: 'NotaDePruebaLimbo',
    targetFolder: 'proyectos/TaPeer'
  });
  assert(moveRes.success, `moveNote falló: ${moveRes.error}`);
  const movedPath = path.join(tempVaultDir, 'proyectos', 'TaPeer', 'NotaDePruebaLimbo.md');
  assert(fs.existsSync(movedPath), 'El archivo no está en la nueva ubicación');
  assert(!fs.existsSync(expectedLimboPath), 'El archivo aún existe en la ubicación antigua');
  console.log('✅ moveNote reubicó el archivo correctamente a proyectos/TaPeer');

  // 5. Probar moveNote prevención de Path Traversal
  console.log('\n--- Probando protección de Path Traversal en moveNote ---');
  const traversalRes = await toolActions.moveNote({
    title: 'NotaDeTaPeer',
    targetFolder: '../../Windows/System32'
  });
  assert(!traversalRes.success, 'moveNote debió rechazar el path traversal');
  assert(traversalRes.error.includes('Acceso denegado'), 'Mensaje de error incorrecto para path traversal');
  console.log('✅ moveNote bloqueó el intento de path traversal.');

  // 6. Probar connectNotes con guardia de aislamiento entre proyectos
  console.log('\n--- Probando aislamiento en connectNotes ---');
  // Crear nota en CucumBrain
  setActiveProjectContext('CucumBrain');
  await toolActions.createNote({
    title: 'NotaDeCucumBrain',
    content: 'Contenido de CucumBrain'
  });

  // Intentar conectar NotaDeTaPeer con NotaDeCucumBrain sin allowCrossProject
  const connBlocked = await toolActions.connectNotes({
    originTitle: 'NotaDeTaPeer',
    destinationTitle: 'NotaDeCucumBrain'
  });
  assert(!connBlocked.success, 'connectNotes debió rechazar la conexión entre proyectos distintos sin flag');
  assert(connBlocked.error.includes('Aviso de aislamiento'), 'Error debió mencionar aviso de aislamiento');
  console.log('✅ connectNotes bloqueó exitosamente la conexión cruzada accidental.');

  // Conectar con allowCrossProject: true
  const connAllowed = await toolActions.connectNotes({
    originTitle: 'NotaDeTaPeer',
    destinationTitle: 'NotaDeCucumBrain',
    allowCrossProject: true
  });
  assert(connAllowed.success, `connectNotes debió permitir con allowCrossProject: true: ${connAllowed.error}`);
  console.log('✅ connectNotes permitió la conexión explícita con allowCrossProject: true.');

  // 7. Probar queryNotesByMetadata con filtros de project y folder
  console.log('\n--- Probando queryNotesByMetadata ---');
  const qProj = await toolActions.queryNotesByMetadata({ project: 'TaPeer' });
  assert(qProj.success, 'queryNotesByMetadata falló');
  assert(qProj.notes.length >= 1, 'Debió encontrar al menos una nota de TaPeer');
  assert(qProj.notes.every(n => n.project?.toLowerCase() === 'tapeer'), 'Todas las notas devueltas deben ser de TaPeer');
  console.log(`✅ queryNotesByMetadata filtró correctamente por project=TaPeer (${qProj.notes.length} notas).`);

} finally {
  // Limpieza de directorio temporal
  if (fs.existsSync(tempVaultDir)) {
    fs.rmSync(tempVaultDir, { recursive: true, force: true });
  }
}

console.log('\n🎉 ¡TODOS LOS TESTS DE LA FASE 2 PASARON EXITOSAMENTE!');
