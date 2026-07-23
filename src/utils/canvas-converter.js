import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { callLLM } from '../agent/agent.js';

// Directorio de notas (prioridad: NOTES_PATH, fallback: ./vault)
const notesPath = process.env.NOTES_PATH 
  ? path.resolve(process.env.NOTES_PATH) 
  : path.resolve('./vault');

/**
 * Escanea recursivamente un directorio buscando archivos con una extensión dada.
 */
function findFiles(dir, ext) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findFiles(filePath, ext));
    } else if (filePath.endsWith(ext)) {
      results.push(filePath);
    }
  }
  return results;
}

/**
 * Resuelve y describe de forma legible un nodo de Canvas según su tipo.
 */
function describeNode(node) {
  let colorName = 'Gris (Default)';
  if (node.color === '1') colorName = 'Rojo (Crítico/Bloqueante)';
  else if (node.color === '3') colorName = 'Amarillo (Importante/Investigación)';
  else if (node.color === '6') colorName = 'Violeta (Estrategia/Principio)';
  else if (node.color === '#ffffff') colorName = 'Blanco';

  switch (node.type) {
    case 'text':
      return `Tarjeta de texto [Color Borde: ${colorName}] (Contenido: "${node.text.trim()}")`;
    case 'file':
      const noteName = path.basename(node.file, '.md');
      return `Nota enlazada [Color Borde: ${colorName}]: "[[${noteName}]]"`;
    case 'link':
      return `Enlace externo [Color Borde: ${colorName}]: "${node.url}"`;
    case 'group':
      return `Grupo [Color Borde: ${colorName}]: "${node.label || 'Sin etiqueta'}"`;
    default:
      return `Nodo de tipo desconocido (${node.type}) [Color Borde: ${colorName}]`;
  }
}

/**
 * Encuentra el grupo espacial más pequeño en el que se ubica un nodo según sus coordenadas en el Canvas.
 */
function getNodeGroup(node, groups) {
  let containingGroup = null;
  let minArea = Infinity;

  for (const group of groups) {
    const isInside = 
      node.x >= group.x && 
      node.x <= group.x + group.width &&
      node.y >= group.y && 
      node.y <= group.y + group.height;

    if (isInside) {
      const area = group.width * group.height;
      if (area < minArea) {
        minArea = area;
        containingGroup = group;
      }
    }
  }

  return containingGroup ? containingGroup.label : 'Fuera de grupo (Global)';
}

/**
 * Procesa y convierte un archivo .canvas en una nota de Markdown descriptiva usando IA.
 */
async function convertCanvasFile(canvasPath) {
  const mdPath = canvasPath.substring(0, canvasPath.lastIndexOf('.')) + '.md';

  // Evitar sobreescribir notas que ya fueron convertidas
  if (fs.existsSync(mdPath)) {
    console.log(`[Canvas] Nota ya existente, saltando: ${path.basename(mdPath)}`);
    return;
  }

  console.log(`\n[Canvas] Convirtiendo tablero: ${path.basename(canvasPath)}...`);

  try {
    const rawContent = fs.readFileSync(canvasPath, 'utf-8');
    const canvasData = JSON.parse(rawContent);

    const nodes = canvasData.nodes || [];
    const edges = canvasData.edges || [];

    if (nodes.length === 0) {
      console.log(`[Canvas] El tablero está vacío. Saltando.`);
      return;
    }

    // 1. Extraer grupos y mapear nodos no grupales por coordenadas y ID
    const groups = nodes.filter(n => n.type === 'group');
    const nodeMap = new Map();
    const nodesDescription = [];

    nodes.forEach(node => {
      if (node.type !== 'group') {
        const desc = describeNode(node);
        const groupName = getNodeGroup(node, groups);
        nodeMap.set(node.id, desc);
        nodesDescription.push(`- [ID: ${node.id}] [Grupo Canvas: ${groupName}] ${desc}`);
      }
    });

    // 2. Describir las conexiones (edges) de forma legible
    const edgesDescription = [];
    edges.forEach(edge => {
      const fromDesc = nodeMap.get(edge.fromNode) || `ID: ${edge.fromNode}`;
      const toDesc = nodeMap.get(edge.toNode) || `ID: ${edge.toNode}`;
      const labelText = edge.label ? ` con la etiqueta "${edge.label}"` : '';
      edgesDescription.push(`- El elemento "${fromDesc}" apunta al elemento "${toDesc}"${labelText}.`);
    });

    // 3. Crear el prompt estructurado para la IA
    const systemInstruction = `
Eres un analista experto en transcribir y clasificar tableros visuales de Obsidian Canvas a Markdown estructurado.
Se te presentará una lista de elementos clasificados semánticamente con sus colores de borde originales, su pertenencia a grupos espaciales (calculada por coordenadas) y las conexiones reales (flechas).

Tu tarea es generar una nota de Markdown (.md) completa y organizada que refleje fielmente el tablero original sin inventar relaciones falsas ni omitir información.

Reglas críticas de fidelidad:
1. Respeta los grupos espaciales provistos: Organiza la nota utilizando encabezados basados en los grupos ("Programacion", "WA" -que es un subgrupo de Programación-, y "Masas"). Todo elemento marcado en un grupo debe listarse bajo la sección de ese grupo. Los elementos marcados "Fuera de grupo (Global)" deben estar en su propia sección o al inicio de la nota.
2. Relaciones estrictas: Solo asocia o conecta ideas mediante flechas de relación si están listadas explícitamente en la "LISTA DE CONEXIONES". Si un elemento no tiene conexiones entrantes ni salientes (como el caso de la tarjeta psmux en Programación), lístalo como un concepto o idea independiente dentro de su sección correspondiente. No inventes relaciones lógicas de dependencia que no estén dibujadas en el tablero.
3. Clasificación detallada: Para cada grupo, clasifica las tarjetas en las siguientes categorías según su contenido:
   - 🌟 **Principios y Conceptos de Negocio / Filosofía:** Tarjetas de color Violeta o con textos inspiracionales/estratégicos (ej: "Para ganar como freelancer...").
   - ❓ **Dudas e Interrogantes:** Preguntas abiertas del usuario.
   - 💡 **Ideas de Proyectos o SaaS:** Propuestas de desarrollo o aplicaciones nuevas.
   - 📋 **Tareas y Acciones Técnicas:** Cosas para hacer o investigar.
     - Clasifica su prioridad según el color de borde:
       * **[Crítica / Bloqueante]** (Color Borde: Rojo).
       * **[Importante / Investigación]** (Color Borde: Amarillo).
       * **[Pendiente]** (Borde Gris/Normal).
4. Estado de las Tareas: Dado que muchas tareas pueden estar descartadas, dudosas o activas, representa las tareas de cada sección con checkboxes. Usa la siguiente convención para que el usuario pueda modificarlas fácilmente en Obsidian:
   - \`[ ]\` Tarea activa / pendiente.
   - \`[?]\` Tarea en evaluación / duda.
   - \`[-]\` Tarea descartada o en pausa (si su texto indica dudas o descartes, o si el usuario lo sugiere).
5. No resumas excesivamente: Incluye el contenido exacto o completo de las tarjetas de texto. No recortes ni ignores elementos del tablero.

Es OBLIGATORIO comenzar con el Front Matter YAML exacto:
---
id: "slug-de-la-nota"
tipo: "mapa-ideas"          
estado: "incubando"     
tags:
  - programacion
  - automatizacion
  - masas
conexiones:
  - "[[Nota Relacionada 1]]"
---
En la propiedad "conexiones" del frontmatter, debes listar todos los nombres de archivos/notas reales (nodos de tipo 'file' que viste en el tablero) con el formato "[[Nombre de Nota]]".

Devuelve ÚNICAMENTE el código Markdown resultante. No agregues bloques de código con triple comilla (\`\`\`) ni texto adicional.
    `.trim();

    const promptText = `
Tablero Canvas analizado: "${path.basename(canvasPath, '.canvas')}"

--- LISTA DE NODOS (ELEMENTOS) ---
${nodesDescription.join('\n')}

--- LISTA DE CONEXIONES (RELACIONES) ---
${edgesDescription.length > 0 ? edgesDescription.join('\n') : 'No hay conexiones explícitas entre elementos.'}
    `.trim();

    // 4. Solicitar a la IA la redacción y clasificación
    const markdownResult = await callLLM(systemInstruction, promptText);

    // 5. Guardar la nota resultante
    fs.writeFileSync(mdPath, markdownResult.trim(), 'utf-8');
    console.log(`✅ [Canvas] Tablero convertido con éxito en nota física: ${path.basename(mdPath)}`);

  } catch (err) {
    console.error(`❌ [Canvas] Error al convertir ${path.basename(canvasPath)}:`, err.message);
  }
}

/**
 * Escanea la bóveda de notas buscando tableros .canvas sin convertir y los procesa.
 */
export async function convertAllCanvas() {
  console.log(`[Canvas] Buscando tableros .canvas en la bóveda: ${notesPath}`);
  const canvasFiles = findFiles(notesPath, '.canvas');

  if (canvasFiles.length === 0) {
    console.log('[Canvas] No se encontraron archivos .canvas en la bóveda.');
    return;
  }

  console.log(`[Canvas] Se encontraron ${canvasFiles.length} tableros.`);
  for (const canvasPath of canvasFiles) {
    await convertCanvasFile(canvasPath);
  }
  console.log('[Canvas] Proceso de conversión de tableros finalizado.');
}

// Si se ejecuta este script directamente
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  convertAllCanvas().catch(console.error);
}
