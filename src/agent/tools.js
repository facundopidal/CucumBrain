import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import db from '../database/db.js';
import { indexNote, deleteNote as removeNoteFromIndex, slugify } from '../database/indexer.js';

const targetPath = process.env.NOTES_PATH || process.env.OBSIDIAN_VAULT_PATH;
const NOTES_PATH = targetPath 
  ? path.resolve(targetPath) 
  : path.resolve('./vault');

// Definición unificada de esquemas de herramientas usando tipos lowercase por defecto (OpenAI standard)
export const tools = [
  {
    name: 'createNote',
    description: 'Crea una nueva nota de Obsidian con metadatos de frontmatter YAML e indexa inmediatamente.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'El título de la nota (se usará como nombre de archivo).'
        },
        content: {
          type: 'string',
          description: 'El contenido principal de la nota en formato Markdown.'
        },
        type_id: {
          type: 'string',
          description: 'Tipo o categoría de la nota (ej: idea, project, coding-session, resource, etc.). Por defecto es "idea".'
        },
        status: {
          type: 'string',
          description: 'Estado de la nota (ej: incubating, active, completed, paused, archived). Por defecto es "incubating".'
        },
        importance: {
          type: 'integer',
          description: 'Nivel de importancia de la nota del 1 al 5. Por defecto es 3.'
        }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'appendNoteContent',
    description: 'Agrega texto o contenido al final de una nota markdown existente y re-indexa la nota.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'El título o ID de la nota existente.'
        },
        content: {
          type: 'string',
          description: 'El contenido en Markdown que se desea añadir.'
        }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'connectNotes',
    description: 'Enlaza una nota origen con una nota destino insertando un WikiLink ([[Nota Destino]]) al final de la nota origen.',
    parameters: {
      type: 'object',
      properties: {
        originTitle: {
          type: 'string',
          description: 'El título o ID de la nota origen.'
        },
        destinationTitle: {
          type: 'string',
          description: 'El título o ID de la nota destino a la que se apunta.'
        }
      },
      required: ['originTitle', 'destinationTitle']
    }
  },
  {
    name: 'listNotes',
    description: 'Obtiene una lista de todas las notas indexadas con sus metadatos (evita la creación de duplicados).',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'queryNotesByMetadata',
    description: 'Busca y filtra notas en la base de datos basándose en sus metadatos estructurados sin leer el archivo físico.',
    parameters: {
      type: 'object',
      properties: {
        type_id: {
          type: 'string',
          description: 'Filtra por tipo de nota (ej: project, idea, finance, resource, etc.).'
        },
        status: {
          type: 'string',
          description: 'Filtra por estado (ej: active, paused, incubating, completed).'
        },
        importance: {
          type: 'integer',
          description: 'Filtra por nivel mínimo de importancia (del 1 al 5).'
        }
      }
    }
  },
  {
    name: 'updateNoteMetadata',
    description: 'Actualiza los metadatos YAML frontmatter de una nota (ej: tipo, estado, importancia) sin modificar el cuerpo de texto principal de la nota.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'El título o ID de la nota existente.'
        },
        type_id: {
          type: 'string',
          description: 'El nuevo tipo o categoría de la nota (ej: project, idea, etc.).'
        },
        status: {
          type: 'string',
          description: 'El nuevo estado de la nota (ej: active, paused, incubating, completed).'
        },
        importance: {
          type: 'integer',
          description: 'El nuevo nivel de importancia (del 1 al 5).'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'replaceNoteSection',
    description: 'Reemplaza el contenido de una sección o encabezado Markdown específico dentro de una nota existente.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'El título o ID de la nota existente.'
        },
        sectionHeader: {
          type: 'string',
          description: 'El nombre exacto del encabezado o sección a reemplazar (sin los caracteres #).'
        },
        newContent: {
          type: 'string',
          description: 'El nuevo contenido en Markdown que reemplazará a esa sección.'
        }
      },
      required: ['title', 'sectionHeader', 'newContent']
    }
  },
  {
    name: 'readNote',
    description: 'Lee el contenido completo y metadatos de una nota específica por su título o ID.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'El título o ID de la nota a leer.'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'deleteNote',
    description: 'Elimina físicamente una nota del disco y borra sus registros de la base de datos.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'El título o ID de la nota a eliminar.'
        }
      },
      required: ['title']
    }
  }
];

// Implementación de las funciones locales que ejecuta el agente
export const toolActions = {
  createNote: async ({ title, content, type_id = 'idea', status = 'incubating', importance = 3 }) => {
    try {
      if (!title) {
        return { success: false, error: 'El título es requerido.' };
      }

      // Asegurar que la carpeta vault exista
      if (!fs.existsSync(NOTES_PATH)) {
        fs.mkdirSync(NOTES_PATH, { recursive: true });
      }

      const fileName = `${title}.md`;
      const filePath = path.join(NOTES_PATH, fileName);

      // Seguridad: Validar que no se salga de NOTES_PATH
      const resolvedPath = path.resolve(filePath);
      if (!resolvedPath.startsWith(NOTES_PATH)) {
        return { success: false, error: 'Acceso denegado fuera de la carpeta de notas.' };
      }

      if (fs.existsSync(resolvedPath)) {
        return { success: false, error: `La nota "${title}" ya existe en el sistema.` };
      }

      const id = slugify(title);
      const dateStr = new Date().toISOString().split('T')[0];
      const frontMatter = [
        '---',
        `id: ${id}`,
        `title: "${title.replace(/"/g, '\\"')}"`,
        `tipo: ${type_id}`,
        `estado: ${status}`,
        `importancia: ${importance}`,
        `fecha_creacion: ${dateStr}`,
        `fecha_modificacion: ${dateStr}`,
        'conexiones: []',
        '---',
        ''
      ].join('\n');

      const fileContent = frontMatter + (content || '');
      fs.writeFileSync(resolvedPath, fileContent, 'utf-8');

      // Indexar inmediatamente
      indexNote(resolvedPath);

      return {
        success: true,
        message: `Nota "${title}" creada exitosamente.`,
        note: { id, title, type_id, status, importance }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  appendNoteContent: async ({ title, content }) => {
    try {
      if (!title || !content) {
        return { success: false, error: 'El título y el contenido son requeridos.' };
      }

      // Buscar nota en base de datos
      const note = db.prepare('SELECT file_path, title FROM notes WHERE title = ? OR id = ?').get(title, title);

      let filePath;
      if (note && note.file_path) {
        filePath = note.file_path;
      } else {
        filePath = path.join(NOTES_PATH, `${title}.md`);
      }

      const resolvedPath = path.resolve(filePath);
      if (!resolvedPath.startsWith(NOTES_PATH)) {
        return { success: false, error: 'Acceso denegado fuera de la carpeta de notas.' };
      }

      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: `La nota "${title}" no existe físicamente.` };
      }

      let fileContent = fs.readFileSync(resolvedPath, 'utf-8');

      if (fileContent.length > 0 && !fileContent.endsWith('\n')) {
        fileContent += '\n';
      }

      fileContent += content;
      fs.writeFileSync(resolvedPath, fileContent, 'utf-8');

      // Indexar inmediatamente
      indexNote(resolvedPath);

      return {
        success: true,
        message: `Contenido añadido exitosamente a la nota "${title}".`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  connectNotes: async ({ originTitle, destinationTitle }) => {
    try {
      if (!originTitle || !destinationTitle) {
        return { success: false, error: 'Se requiere nota de origen y nota de destino.' };
      }

      // Buscar nota de origen en la base de datos
      const originNote = db.prepare('SELECT file_path, title FROM notes WHERE title = ? OR id = ?').get(originTitle, originTitle);

      let originPath;
      if (originNote && originNote.file_path) {
        originPath = originNote.file_path;
      } else {
        originPath = path.join(NOTES_PATH, `${originTitle}.md`);
      }

      const resolvedOriginPath = path.resolve(originPath);
      if (!resolvedOriginPath.startsWith(NOTES_PATH)) {
        return { success: false, error: 'Acceso denegado fuera de la carpeta de notas.' };
      }

      if (!fs.existsSync(resolvedOriginPath)) {
        return { success: false, error: `La nota origen "${originTitle}" no existe.` };
      }

      let fileContent = fs.readFileSync(resolvedOriginPath, 'utf-8');
      const wikiLink = `[[${destinationTitle}]]`;

      // Evitar duplicar
      if (fileContent.includes(wikiLink)) {
        return {
          success: true,
          message: `La nota "${originTitle}" ya tiene un enlace a "${destinationTitle}".`
        };
      }

      if (fileContent.length > 0 && !fileContent.endsWith('\n')) {
        fileContent += '\n';
      }

      fileContent += `\nEnlace: ${wikiLink}`;
      fs.writeFileSync(resolvedOriginPath, fileContent, 'utf-8');

      // Indexar inmediatamente para actualizar las relaciones
      indexNote(resolvedOriginPath);

      return {
        success: true,
        message: `Enlace creado exitosamente: "${originTitle}" -> "${destinationTitle}".`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  listNotes: async () => {
    try {
      const notes = db.prepare('SELECT id, title, type_id, status, importance FROM notes WHERE status != \'stub\'').all();
      return { success: true, notes };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  queryNotesByMetadata: async ({ type_id, status, importance }) => {
    try {
      let query = 'SELECT id, title, type_id, status, importance FROM notes WHERE status != \'stub\'';
      const params = [];
      if (type_id) {
        query += ' AND type_id = ?';
        params.push(type_id);
      }
      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }
      if (importance) {
        query += ' AND importance >= ?';
        params.push(importance);
      }
      const notes = db.prepare(query).all(...params);
      return { success: true, notes };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  updateNoteMetadata: async ({ title, type_id, status, importance }) => {
    try {
      if (!title) {
        return { success: false, error: 'El título es requerido.' };
      }

      const note = db.prepare('SELECT file_path, title FROM notes WHERE LOWER(title) = LOWER(?) OR LOWER(id) = LOWER(?)').get(title, title);
      if (!note || !note.file_path) {
        return { success: false, error: `La nota "${title}" no existe en el índice.` };
      }

      const resolvedPath = path.resolve(note.file_path);
      if (!resolvedPath.startsWith(NOTES_PATH)) {
        return { success: false, error: 'Acceso denegado fuera de la carpeta de notas.' };
      }

      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: `El archivo físico de la nota "${title}" no existe.` };
      }

      const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      const parsed = matter(fileContent);

      if (type_id !== undefined) parsed.data.tipo = type_id;
      if (status !== undefined) parsed.data.estado = status;
      if (importance !== undefined) parsed.data.importancia = importance;
      parsed.data.fecha_modificacion = new Date().toISOString().split('T')[0];

      const newFileContent = matter.stringify(parsed.content, parsed.data);
      fs.writeFileSync(resolvedPath, newFileContent, 'utf-8');

      indexNote(resolvedPath);

      return {
        success: true,
        message: `Metadatos de la nota "${title}" actualizados exitosamente.`,
        note: { title: note.title, type_id: parsed.data.tipo, status: parsed.data.estado, importance: parsed.data.importancia }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  replaceNoteSection: async ({ title, sectionHeader, newContent }) => {
    try {
      if (!title || !sectionHeader) {
        return { success: false, error: 'Se requiere título y nombre de sección.' };
      }

      const note = db.prepare('SELECT file_path, title FROM notes WHERE LOWER(title) = LOWER(?) OR LOWER(id) = LOWER(?)').get(title, title);
      if (!note || !note.file_path) {
        return { success: false, error: `La nota "${title}" no existe.` };
      }

      const resolvedPath = path.resolve(note.file_path);
      if (!resolvedPath.startsWith(NOTES_PATH)) {
        return { success: false, error: 'Acceso denegado fuera de la carpeta de notas.' };
      }

      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: `El archivo físico de la nota "${title}" no existe.` };
      }

      const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      const parsed = matter(fileContent);
      let body = parsed.content;

      const headerRegex = new RegExp(`^(#{1,6})\\s+${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
      const match = headerRegex.exec(body);

      if (!match) {
        return { success: false, error: `No se encontró la sección "${sectionHeader}" en la nota "${title}".` };
      }

      const headerLevel = match[1];
      const matchIndex = match.index;
      const contentStartIndex = matchIndex + match[0].length;

      const nextHeaderRegex = new RegExp(`^#{1,${headerLevel.length}}\\s+`, 'm');
      const remainingBody = body.slice(contentStartIndex);
      const nextHeaderMatch = nextHeaderRegex.exec(remainingBody);

      let sectionEndIndex;
      if (nextHeaderMatch) {
        sectionEndIndex = contentStartIndex + nextHeaderMatch.index;
      } else {
        sectionEndIndex = body.length;
      }

      const updatedBody = body.slice(0, contentStartIndex) + '\n' + (newContent || '').trim() + '\n\n' + body.slice(sectionEndIndex).trimStart();
      const newFileContent = matter.stringify(updatedBody, parsed.data);
      fs.writeFileSync(resolvedPath, newFileContent, 'utf-8');

      indexNote(resolvedPath);

      return {
        success: true,
        message: `Sección "${sectionHeader}" reemplazada exitosamente en la nota "${title}".`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  readNote: async ({ title }) => {
    try {
      if (!title) {
        return { success: false, error: 'El título es requerido.' };
      }

      const note = db.prepare('SELECT file_path, title, type_id, status, importance FROM notes WHERE LOWER(title) = LOWER(?) OR LOWER(id) = LOWER(?)').get(title, title);
      if (!note || !note.file_path) {
        return { success: false, error: `La nota "${title}" no se encuentra en el índice.` };
      }

      const resolvedPath = path.resolve(note.file_path);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: `El archivo físico de la nota "${title}" no existe.` };
      }

      const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      return {
        success: true,
        note: {
          title: note.title,
          type_id: note.type_id,
          status: note.status,
          importance: note.importance,
          content: fileContent
        }
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  deleteNote: async ({ title }) => {
    try {
      if (!title) {
        return { success: false, error: 'El título es requerido.' };
      }

      const note = db.prepare('SELECT file_path, title FROM notes WHERE LOWER(title) = LOWER(?) OR LOWER(id) = LOWER(?)').get(title, title);
      if (!note || !note.file_path) {
        return { success: false, error: `La nota "${title}" no se encuentra registrada.` };
      }

      const resolvedPath = path.resolve(note.file_path);
      if (!resolvedPath.startsWith(NOTES_PATH)) {
        return { success: false, error: 'Acceso denegado fuera de la carpeta de notas.' };
      }

      if (fs.existsSync(resolvedPath)) {
        fs.unlinkSync(resolvedPath);
      }

      removeNoteFromIndex(resolvedPath);

      return {
        success: true,
        message: `La nota "${title}" ha sido eliminada físicamente de la Bóveda y de la base de datos.`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};

// Adapta recursivamente los tipos de parámetros según el proveedor
// Gemini requiere tipos en mayúsculas (STRING, OBJECT, etc.), OpenAI/Groq/OpenRouter requieren minúsculas
export function getToolsSchemaForProvider(provider) {
  const isGemini = provider.toLowerCase() === 'gemini';

  const adaptParam = (param) => {
    if (!param || typeof param !== 'object') return param;
    const newParam = { ...param };
    if (typeof newParam.type === 'string') {
      newParam.type = isGemini ? newParam.type.toUpperCase() : newParam.type.toLowerCase();
    }
    if (newParam.properties) {
      const newProps = {};
      for (const [key, val] of Object.entries(newParam.properties)) {
        newProps[key] = adaptParam(val);
      }
      newParam.properties = newProps;
    }
    if (newParam.items) {
      newParam.items = adaptParam(newParam.items);
    }
    return newParam;
  };

  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: adaptParam(tool.parameters)
  }));
}
