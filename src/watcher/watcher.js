import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import { indexNote, deleteNote } from '../database/indexer.js';

// Directorio a vigilar (prioridad: variable de entorno NOTES_PATH, fallback: ./vault)
const notesPath = process.env.NOTES_PATH 
  ? path.resolve(process.env.NOTES_PATH) 
  : path.resolve('./vault');

// Crear la carpeta vault si no existe
if (!fs.existsSync(notesPath)) {
  fs.mkdirSync(notesPath, { recursive: true });
  console.log(`[Watcher] Carpeta de notas creada en: ${notesPath}`);
}

console.log(`[Watcher] Vigilando cambios en las notas en: ${notesPath}`);

// Inicializar chokidar para vigilar archivos .md, ignorando los dibujos de Excalidraw
const watcher = chokidar.watch(`${notesPath}/**/*.md`, {
  persistent: true,
  ignoreInitial: false, // Procesa los archivos existentes al iniciar
  ignored: (filePath) => {
    // Ignorar si es un archivo de dibujo de Excalidraw (.excalidraw.md)
    return filePath.endsWith('.excalidraw.md') || filePath.toLowerCase().includes('.excalidraw');
  },
  awaitWriteFinish: {
    stabilityThreshold: 500, // Espera 500ms tras el último cambio para evitar lecturas parciales
    pollInterval: 100
  }
});

// Eventos
watcher
  .on('add', (filePath) => {
    console.log(`[Watcher] Archivo detectado (adición): ${path.basename(filePath)}`);
    try {
      indexNote(filePath);
    } catch (err) {
      console.error(`[Watcher] Error al indexar ${filePath}:`, err.message);
    }
  })
  .on('change', (filePath) => {
    console.log(`[Watcher] Archivo detectado (modificación): ${path.basename(filePath)}`);
    try {
      indexNote(filePath);
    } catch (err) {
      console.error(`[Watcher] Error al indexar ${filePath}:`, err.message);
    }
  })
  .on('unlink', (filePath) => {
    console.log(`[Watcher] Archivo detectado (eliminación): ${path.basename(filePath)}`);
    try {
      deleteNote(filePath);
    } catch (err) {
      console.error(`[Watcher] Error al eliminar ${filePath}:`, err.message);
    }
  })
  .on('error', (error) => {
    console.error(`[Watcher] Error del vigilante:`, error);
  });

export default watcher;
