import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import db from './db.js';

// Función para limpiar/normalizar un título y convertirlo en slug
export function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD') // Elimina acentos
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

// Extrae el título del link de Obsidian: [[Mi Nota|Texto a mostrar]] -> "Mi Nota"
function parseWikiLink(link) {
  const cleanLink = link.replace(/\[\[|\]\]/g, '');
  return cleanLink.split('|')[0].trim();
}

// Escanea el contenido markdown buscando enlaces [[WikiLinks]] inline
function extractWikiLinks(content) {
  const regex = /\[\[(.*?)\]\]/g;
  const links = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const title = match[1].split('|')[0].trim();
    if (title && !links.includes(title)) {
      links.push(title);
    }
  }
  return links;
}

/**
 * Indexa o actualiza una nota en la base de datos a partir de su archivo markdown.
 * @param {string} filePath - Ruta absoluta o relativa del archivo .md
 */
export function indexNote(filePath) {
  const absolutePath = path.resolve(filePath);
  
  if (!fs.existsSync(absolutePath)) {
    console.warn(`El archivo no existe para indexar: ${absolutePath}`);
    return;
  }

  // Ignorar dibujos de Excalidraw por ruta
  if (absolutePath.endsWith('.excalidraw.md') || absolutePath.toLowerCase().includes('.excalidraw')) {
    return;
  }

  const fileContent = fs.readFileSync(absolutePath, 'utf-8');
  const filename = path.basename(absolutePath, '.md');

  // Parsear Front Matter y Cuerpo usando gray-matter
  const { data: frontMatter, content: markdownBody } = matter(fileContent);

  // Ignorar si el frontmatter indica que es un plugin de Excalidraw
  if (frontMatter && (frontMatter['excalidraw-plugin'] || frontMatter.excalidraw)) {
    return;
  }

  // Determinar el ID de la nota y asegurar tipos primitivos
  const id = frontMatter.id ? String(frontMatter.id).trim() : slugify(filename);
  const title = frontMatter.title ? String(frontMatter.title).trim() : filename;
  const typeId = frontMatter.tipo ? String(frontMatter.tipo).trim() : 'idea';
  const status = frontMatter.estado ? String(frontMatter.estado).trim() : 'incubating';
  const importance = Number(frontMatter.importancia) || 3;

  // Formatear fechas (pueden ser objetos Date generados por js-yaml de gray-matter)
  let createdAt;
  if (frontMatter.fecha_creacion instanceof Date) {
    createdAt = frontMatter.fecha_creacion.toISOString().split('T')[0];
  } else if (frontMatter.fecha_creacion) {
    createdAt = String(frontMatter.fecha_creacion).trim();
  } else {
    createdAt = new Date().toISOString().split('T')[0];
  }

  let updatedAt;
  if (frontMatter.fecha_modificacion instanceof Date) {
    updatedAt = frontMatter.fecha_modificacion.toISOString().split('T')[0];
  } else if (frontMatter.fecha_modificacion) {
    updatedAt = String(frontMatter.fecha_modificacion).trim();
  } else {
    updatedAt = new Date().toISOString().split('T')[0];
  }


  // Iniciar una transacción para consistencia
  const transaction = db.transaction(() => {
    // 1. Asegurar que el tipo de nota exista en la tabla 'types'
    db.prepare(`
      INSERT OR IGNORE INTO types (id, created_by)
      VALUES (?, 'user')
    `).run(typeId);

    // 2. Obtener estado anterior para registrar en historial de cambios
    const existingNote = db.prepare(`
      SELECT type_id, status, importance FROM notes WHERE id = ?
    `).get(id);

    if (existingNote) {
      // Registrar cambios en el historial si cambió algún campo clave
      const fieldsToTrack = [
        { field: 'type', old: existingNote.type_id, new: typeId },
        { field: 'status', old: existingNote.status, new: status },
        { field: 'importance', old: existingNote.importance, new: importance }
      ];

      for (const track of fieldsToTrack) {
        if (track.old !== track.new) {
          db.prepare(`
            INSERT INTO change_history (note_id, modified_field, old_value, new_value)
            VALUES (?, ?, ?, ?)
          `).run(id, track.field, String(track.old), String(track.new));
        }
      }

      // Actualizar nota existente
      db.prepare(`
        UPDATE notes
        SET file_path = ?, title = ?, type_id = ?, status = ?, importance = ?, content = ?, updated_at = ?
        WHERE id = ?
      `).run(absolutePath, title, typeId, status, importance, markdownBody, updatedAt, id);
    } else {
      // Si la nota ya estaba como 'stub' (creada como enlace huérfano), la actualizamos
      const isStub = db.prepare(`
        SELECT status FROM notes WHERE id = ?
      `).get(id);

      if (isStub && isStub.status === 'stub') {
        db.prepare(`
          UPDATE notes
          SET file_path = ?, title = ?, type_id = ?, status = ?, importance = ?, content = ?, created_at = ?, updated_at = ?
          WHERE id = ?
        `).run(absolutePath, title, typeId, status, importance, markdownBody, createdAt, updatedAt, id);
      } else {
        // Insertar nota nueva
        db.prepare(`
          INSERT INTO notes (id, file_path, title, type_id, status, importance, content, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, absolutePath, title, typeId, status, importance, markdownBody, createdAt, updatedAt);
      }
    }

    // 3. Procesar conexiones/enlaces (Frontmatter conexiones + WikiLinks del cuerpo)
    const connectionsFromFrontmatter = Array.isArray(frontMatter.conexiones)
      ? frontMatter.conexiones.map(c => parseWikiLink(c))
      : [];
    const connectionsFromContent = extractWikiLinks(markdownBody);
    
    // Unificar todas las conexiones y filtrar vacíos
    const allUniqueConnections = [...new Set([...connectionsFromFrontmatter, ...connectionsFromContent])].filter(Boolean);

    // Borrar relaciones anteriores donde esta nota es el origen
    db.prepare(`DELETE FROM note_relations WHERE origin_note_id = ?`).run(id);

    // Insertar nuevas relaciones
    for (const targetTitle of allUniqueConnections) {
      const targetSlug = slugify(targetTitle);
      
      // Buscar si el destino existe por ID (slug) o por Título
      let targetNote = db.prepare(`
        SELECT id FROM notes WHERE id = ? OR title = ?
      `).get(targetSlug, targetTitle);

      let targetId;
      if (targetNote) {
        targetId = targetNote.id;
      } else {
        // Crear nota "stub" si el destino no existe aún
        targetId = targetSlug;
        db.prepare(`
          INSERT OR IGNORE INTO notes (id, title, status)
          VALUES (?, ?, 'stub')
        `).run(targetId, targetTitle);
      }

      // Evitar autoreferencias
      if (id !== targetId) {
        db.prepare(`
          INSERT OR IGNORE INTO note_relations (origin_note_id, destination_note_id)
          VALUES (?, ?)
        `).run(id, targetId);
      }
    }
  });

  transaction();
  console.log(`[Indexer] Nota indexada: "${title}" (ID: ${id})`);
}

/**
 * Elimina una nota de la base de datos al ser eliminado su archivo físico.
 * @param {string} filePath - Ruta absoluta o relativa del archivo .md
 */
export function deleteNote(filePath) {
  const absolutePath = path.resolve(filePath);
  
  // Buscar la nota por su file_path
  const note = db.prepare(`SELECT id, title FROM notes WHERE file_path = ?`).get(absolutePath);
  
  if (note) {
    // Al eliminar la nota, las relaciones se eliminan en cascada (ON DELETE CASCADE)
    db.prepare(`DELETE FROM notes WHERE id = ?`).run(note.id);
    console.log(`[Indexer] Nota eliminada de la base de datos: "${note.title}" (ID: ${note.id})`);
  } else {
    console.warn(`[Indexer] Intento de eliminar una nota no registrada: ${absolutePath}`);
  }
}
