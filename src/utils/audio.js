import fs from 'fs';
import path from 'path';
import https from 'https';

const TEMP_DIR = path.resolve('./temp');

/**
 * Descarga un archivo desde una URL y lo guarda en el directorio temporal.
 * Usamos https.get en lugar de fetch para garantizar la compatibilidad de red en Windows.
 * @param {string} url - URL del archivo a descargar
 * @param {string} fileName - Nombre del archivo de destino
 * @returns {Promise<string>} - Ruta absoluta del archivo descargado
 */
export function downloadTelegramFile(url, fileName) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
      }

      const destPath = path.join(TEMP_DIR, fileName);
      const file = fs.createWriteStream(destPath);

      https.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Error HTTP al descargar: ${response.statusCode} ${response.statusMessage}`));
          return;
        }

        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          console.log(`[Audio] Archivo guardado temporalmente en: ${destPath}`);
          resolve(destPath);
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {}); // Borrar archivo parcial en caso de error
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Limpia un archivo temporal.
 * @param {string} filePath - Ruta absoluta del archivo a borrar
 */
export function cleanTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Audio] Archivo temporal eliminado: ${filePath}`);
    }
  } catch (err) {
    console.error(`[Audio] Error al eliminar archivo temporal ${filePath}:`, err.message);
  }
}
