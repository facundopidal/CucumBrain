import { GoogleGenerativeAI } from '@google/generative-ai';
import db from '../database/db.js';
import { toolActions, getToolsSchemaForProvider, setActiveProjectContext } from './tools.js';

// Lista de palabras vacías (stop words) comunes en español para limpiar las consultas
const STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero', 'si',
  'de', 'del', 'a', 'al', 'en', 'con', 'para', 'por', 'sobre', 'entre', 'sin',
  'que', 'como', 'cuando', 'donde', 'quien', 'cual', 'cuyo', 'este', 'esta',
  'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'mi', 'mis',
  'tu', 'tus', 'su', 'sus', 'me', 'te', 'se', 'nos', 'lo', 'le', 'les', 'yo',
  'tu', 'el', 'ella', 'nosotros', 'ellos', 'ellas', 'hacer', 'tener', 'querer',
  'saber', 'ver', 'dar', 'ir', 'ser', 'estar'
]);

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Busca notas relevantes en la base de datos basándose en el mensaje del usuario y el proyecto activo.
 * - Si activeProject está presente, devuelve notas de ese proyecto y notas transversales (project IS NULL).
 *   Suprime estrictamente notas de proyectos ajenos.
 * - Si activeProject es null, busca de forma transversal en todas las notas sin supresión de proyectos.
 * @param {string} message - Mensaje o consulta de búsqueda
 * @param {string|null} activeProject - Nombre del proyecto activo detectado
 * @returns {Array} Notas ordenadas por relevancia
 */
export function searchNotes(message, activeProject = null) {
  const words = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
    .replace(/[^a-z0-9\s]/g, ' ')    // Quitar caracteres especiales
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  if (words.length === 0) {
    return [];
  }

  const resultsMap = new Map();

  for (const word of words) {
    const queryTerm = `%${word}%`;
    let sql = `
      SELECT id, title, type_id, status, content, importance, project, folder 
      FROM notes 
      WHERE status != 'stub' 
        AND (title LIKE ? OR content LIKE ? OR id LIKE ?)
    `;
    const params = [queryTerm, queryTerm, queryTerm];

    if (activeProject) {
      // Aislamiento estricto de proyectos: solo notas del proyecto activo o transversales (project IS NULL)
      sql += ' AND (LOWER(project) = LOWER(?) OR project IS NULL)';
      params.push(activeProject);
    }

    const rows = db.prepare(sql).all(...params);

    for (const row of rows) {
      if (!resultsMap.has(row.id)) {
        resultsMap.set(row.id, { ...row, score: 0 });
      }
      const note = resultsMap.get(row.id);
      let boost = (row.importance || 3);
      if (activeProject && row.project && row.project.toLowerCase() === activeProject.toLowerCase()) {
        boost += 5; // Relevancia prioritaria para notas del proyecto en curso sobre notas transversales
      }
      note.score += boost;
    }
  }

  return Array.from(resultsMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * Detecta si el mensaje actual o los turnos recientes hacen referencia a un proyecto específico de la bóveda.
 * @param {string} userMessage - Mensaje del usuario
 * @param {Array} chatHistory - Historial reciente de mensajes
 * @returns {string|null} Nombre del proyecto o null
 */
export function detectActiveProject(userMessage, chatHistory = []) {
  try {
    const projects = db.prepare("SELECT DISTINCT project FROM notes WHERE project IS NOT NULL AND status != 'stub'").all().map(r => r.project);
    if (projects.length === 0) return null;

    // 1. Coincidencia en el mensaje actual del usuario (límites de palabra)
    for (const proj of projects) {
      const regex = new RegExp(`\\b${escapeRegex(proj)}\\b`, 'i');
      if (regex.test(userMessage)) {
        return proj;
      }
    }

    // 2. Coincidencia en los últimos 4 turnos del chat reciente
    const recentMessages = chatHistory.slice(-4).reverse();
    for (const msg of recentMessages) {
      const content = msg.content || '';
      for (const proj of projects) {
        const regex = new RegExp(`\\b${escapeRegex(proj)}\\b`, 'i');
        if (regex.test(content)) {
          return proj;
        }
      }
    }
  } catch (err) {
    console.warn('[ProjectDetection] Error al detectar proyecto activo:', err.message);
  }

  return null;
}

// -------------------------------------------------------------
// ADAPTADORES DE PAYLOAD ENTRE FORMATOS GEMINI Y OPENAI
// -------------------------------------------------------------

/**
 * Convierte el historial de contenido de Gemini al formato estándar de OpenAI chat messages.
 */
export function convertGeminiToOpenAIMessages(systemInstruction, contents) {
  const messages = [];

  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }

  for (const item of contents) {
    if (item.role === 'user') {
      const text = (item.parts || []).map(p => p.text).filter(Boolean).join('\n');
      messages.push({ role: 'user', content: text });
    } else if (item.role === 'model') {
      const funcParts = (item.parts || []).filter(p => p.functionCall);
      const textParts = (item.parts || []).filter(p => p.text).map(p => p.text).join('\n');

      if (funcParts.length > 0) {
        const toolCalls = funcParts.map((p, idx) => ({
          id: `call_${idx}_${Date.now()}`,
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args || {})
          }
        }));
        messages.push({
          role: 'assistant',
          content: textParts || null,
          tool_calls: toolCalls
        });
      } else {
        messages.push({ role: 'assistant', content: textParts || '' });
      }
    } else if (item.role === 'function') {
      const respParts = (item.parts || []).filter(p => p.functionResponse);
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.tool_calls);

      respParts.forEach((p, idx) => {
        const matchingCall = lastAssistant?.tool_calls?.find(tc => tc.function.name === p.functionResponse.name) || lastAssistant?.tool_calls?.[idx];
        messages.push({
          role: 'tool',
          tool_call_id: matchingCall ? matchingCall.id : `call_fallback_${idx}`,
          name: p.functionResponse.name,
          content: typeof p.functionResponse.response === 'string'
            ? p.functionResponse.response
            : JSON.stringify(p.functionResponse.response || {})
        });
      });
    }
  }

  return messages;
}

/**
 * Convierte un arreglo de mensajes de OpenAI al formato contents de Gemini.
 */
export function convertOpenAIToGeminiContents(messages) {
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Las instrucciones de sistema en Gemini van en modelConfig
      continue;
    } else if (msg.role === 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: msg.content || '' }]
      });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const parts = [];
        if (msg.content) parts.push({ text: msg.content });
        for (const tc of msg.tool_calls) {
          let parsedArgs = {};
          try {
            parsedArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
          } catch (_) {}
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: parsedArgs
            }
          });
        }
        contents.push({ role: 'model', parts });
      } else {
        contents.push({
          role: 'model',
          parts: [{ text: msg.content || '' }]
        });
      }
    } else if (msg.role === 'tool') {
      let parsedResponse;
      try {
        parsedResponse = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      } catch (_) {
        parsedResponse = { result: msg.content };
      }
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name: msg.name,
            response: parsedResponse
          }
        }]
      });
    }
  }

  return contents;
}

// -------------------------------------------------------------
// MOTOR DE RESILIENCIA Y REINTENTOS CON JITTER EXPONENCIAL
// -------------------------------------------------------------

function isFastFail(err) {
  const status = err?.status || err?.statusCode || (err?.response && err.response.status);
  return status === 400 || status === 401 || status === 403 || status === 404;
}

export async function executeWithRetry(fn, { maxRetries = 3, providerName, modelName, onDiagnostic } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isFastFail(err)) {
        console.error(`[Resilience] Error fatal no reintentable en ${providerName} (${modelName}):`, err.message);
        throw err;
      }

      if (attempt === maxRetries) {
        break;
      }

      const delayMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
      const delaySec = (delayMs / 1000).toFixed(1);
      const statusText = err?.status || err?.statusCode || err?.code || 'Error';
      const diagMsg = `[⚠️ ${providerName} (${modelName}) falló (${statusText}). Reintentando en ${delaySec}s (intento ${attempt + 1}/${maxRetries})...]`;
      console.warn(`[Resilience] ${diagMsg}`);

      if (onDiagnostic) {
        try { await onDiagnostic(diagMsg); } catch (_) {}
      }

      await new Promise(res => setTimeout(res, delayMs));
    }
  }
  throw lastError;
}

// -------------------------------------------------------------
// DISPATCHERS INDIVIDUALES DE PROVEEDOR
// -------------------------------------------------------------

async function callGeminiDirect({ apiKey, modelName, systemInstruction, contents, useTools }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelConfig = {
    model: modelName,
    systemInstruction: systemInstruction
  };

  if (useTools) {
    modelConfig.tools = [{ functionDeclarations: getToolsSchemaForProvider('gemini') }];
  }

  const model = genAI.getGenerativeModel(modelConfig);
  const result = await model.generateContent({ contents });
  const response = await result.response;

  const functionCalls = (typeof response.functionCalls === 'function')
    ? response.functionCalls()
    : response.functionCalls;

  const candidateContent = response.candidates?.[0]?.content;

  return {
    text: response.text ? response.text() : '',
    toolCalls: (functionCalls || []).map(call => ({
      name: call.name,
      args: call.args
    })),
    rawCandidate: candidateContent,
    provider: 'gemini',
    model: modelName
  };
}

async function callOpenAICompatibleDirect({ apiKey, apiUrl, modelName, systemInstruction, messages, useTools, providerName }) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  if (providerName === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/facundopidal/cucumbrain';
    headers['X-Title'] = 'CucumBrain';
  }

  const payload = {
    model: modelName,
    messages: messages,
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 4000
  };

  if (useTools) {
    payload.tools = getToolsSchemaForProvider(providerName).map(schema => ({
      type: 'function',
      function: schema
    }));
    payload.tool_choice = 'auto';
  }

  console.log(`[LLM] Petición a ${providerName} (${modelName})...`);

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    const errorObj = new Error(`Error en API ${providerName} (${response.status}): ${errorText}`);
    errorObj.status = response.status;
    throw errorObj;
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) {
    throw new Error(`Respuesta inválida de ${providerName} (${modelName})`);
  }

  const toolCalls = (choice.message.tool_calls || []).map(tc => {
    let parsedArgs = {};
    try {
      parsedArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
    } catch (_) {}
    return {
      id: tc.id,
      name: tc.function.name,
      args: parsedArgs
    };
  });

  return {
    text: choice.message.content || '',
    toolCalls,
    rawMessage: choice.message,
    provider: providerName,
    model: modelName
  };
}

// -------------------------------------------------------------
// CASCADA MULTI-PROVEEDOR COMPLETA (Gemini -> Groq -> OpenRouter)
// -------------------------------------------------------------

export async function callLLM(systemInstruction, promptOrMessages, useTools = false, onDiagnostic = null) {
  // Configuración de proveedores y modelos en cascada
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY;

  const primaryModel = process.env.LLM_MODEL || 'gemini-3.1-flash-lite';
  const geminiModels = [primaryModel, 'gemini-2.5-flash', 'gemini-1.5-flash'];
  const groqModels = ['qwen/qwen3.8-27b', 'llama-3.3-70b-versatile'];
  const openRouterModels = [
    'qwen/qwen3.8-27b:free',
    'poolside/laguna-s-2.1:free',
    'z-ai/glm-5.2:free',
    'dots-studio/dots-3-note-preview:free'
  ];

  // Normalizar representación de entrada a Gemini Contents y OpenAI Messages
  let geminiContents;
  let openAiMessages;

  if (Array.isArray(promptOrMessages)) {
    // Detectar formato
    const isGeminiFormat = promptOrMessages.length > 0 && promptOrMessages[0].parts !== undefined;
    if (isGeminiFormat) {
      geminiContents = promptOrMessages;
      openAiMessages = convertGeminiToOpenAIMessages(systemInstruction, promptOrMessages);
    } else {
      openAiMessages = promptOrMessages[0]?.role === 'system' 
        ? promptOrMessages 
        : [{ role: 'system', content: systemInstruction }, ...promptOrMessages];
      geminiContents = convertOpenAIToGeminiContents(openAiMessages);
    }
  } else {
    // Texto simple
    geminiContents = [{ role: 'user', parts: [{ text: String(promptOrMessages) }] }];
    openAiMessages = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: String(promptOrMessages) }
    ];
  }

  const errorsAccumulated = [];

  // TIER 1: Gemini Intra-Provider Fallback
  if (geminiApiKey) {
    for (let i = 0; i < geminiModels.length; i++) {
      const model = geminiModels[i];
      try {
        if (i > 0 && onDiagnostic) {
          const diagMsg = `[🔄 Cambiando a modelo Gemini secundario: ${model}...]`;
          await onDiagnostic(diagMsg);
        }

        const res = await executeWithRetry(
          () => callGeminiDirect({
            apiKey: geminiApiKey,
            modelName: model,
            systemInstruction,
            contents: geminiContents,
            useTools
          }),
          { maxRetries: 3, providerName: 'Gemini', modelName: model, onDiagnostic }
        );
        return res;
      } catch (err) {
        errorsAccumulated.push(`Gemini (${model}): ${err.message}`);
        console.warn(`[Cascade] Modelo Gemini ${model} agotado/fallido:`, err.message);
      }
    }
  }

  // TIER 2: Groq Inter-Provider Fallback
  if (groqApiKey) {
    for (const model of groqModels) {
      try {
        const diagMsg = `[🔄 Gemini no disponible. Cambiando a proveedor fallback: Groq (${model})...]`;
        console.warn(`[Cascade] ${diagMsg}`);
        if (onDiagnostic) {
          try { await onDiagnostic(diagMsg); } catch (_) {}
        }

        const res = await executeWithRetry(
          () => callOpenAICompatibleDirect({
            apiKey: groqApiKey,
            apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
            modelName: model,
            systemInstruction,
            messages: openAiMessages,
            useTools,
            providerName: 'groq'
          }),
          { maxRetries: 3, providerName: 'Groq', modelName: model, onDiagnostic }
        );
        return res;
      } catch (err) {
        errorsAccumulated.push(`Groq (${model}): ${err.message}`);
        console.warn(`[Cascade] Modelo Groq ${model} fallido:`, err.message);
      }
    }
  }

  // TIER 3: OpenRouter Free Tier Fallback
  if (openRouterApiKey) {
    for (const model of openRouterModels) {
      try {
        const diagMsg = `[🔄 Groq no disponible. Cambiando a proveedor fallback: OpenRouter Free Tier (${model})...]`;
        console.warn(`[Cascade] ${diagMsg}`);
        if (onDiagnostic) {
          try { await onDiagnostic(diagMsg); } catch (_) {}
        }

        const res = await executeWithRetry(
          () => callOpenAICompatibleDirect({
            apiKey: openRouterApiKey,
            apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
            modelName: model,
            systemInstruction,
            messages: openAiMessages,
            useTools,
            providerName: 'openrouter'
          }),
          { maxRetries: 3, providerName: 'OpenRouter', modelName: model, onDiagnostic }
        );
        return res;
      } catch (err) {
        errorsAccumulated.push(`OpenRouter (${model}): ${err.message}`);
        console.warn(`[Cascade] Modelo OpenRouter ${model} fallido:`, err.message);
      }
    }
  }

  // Si todos los proveedores agotaron sus intentos
  const fatalMessage = `Todos los proveedores de IA fallaron.\n${errorsAccumulated.join('\n')}`;
  if (onDiagnostic) {
    try { await onDiagnostic(`[❌ Error general en proveedores de IA: ${errorsAccumulated.slice(-1)[0] || 'Desconocido'}]`); } catch (_) {}
  }
  throw new Error(fatalMessage);
}

// -------------------------------------------------------------
// CONSOLIDACIÓN DE SESIÓN Y MEMORIA A LARGO PLAZO
// -------------------------------------------------------------

function parseLLMJSON(text) {
  try {
    const clean = text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Agent] Error al parsear JSON de la IA:', err.message, 'Texto recibido:', text);
    return { updates: [] };
  }
}

async function consolidateSession() {
  console.log('[Memory] Iniciando consolidación de la sesión de chat anterior...');

  const history = db.prepare('SELECT role, content FROM chat_history ORDER BY id ASC').all();
  const assistantMessages = history.filter(m => m.role === 'assistant');
  if (assistantMessages.length === 0) {
    console.log('[Memory] La sesión no tiene suficientes interacciones para consolidar. Limpiando historial.');
    db.prepare('DELETE FROM chat_history').run();
    return;
  }

  const conversationText = history
    .map(m => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
    .join('\n');

  try {
    const summaryInstruction = 'Eres un motor de consolidación de memoria. Escribe un resumen sumamente conciso, estructurado y en español de la conversación provista. Enfócate en decisiones tomadas, temas de interés y pendientes del usuario.';
    const summaryRes = await callLLM(summaryInstruction, `Conversación a resumir:\n${conversationText}`, false);
    let summary = typeof summaryRes === 'string' ? summaryRes : summaryRes.text;
    if (!summary || !summary.trim()) {
      summary = 'Sesión conversacional de rutina sin decisiones o temas clave pendientes registrados.';
    }
    
    db.prepare('INSERT INTO session_summaries (summary) VALUES (?)').run(summary);
    console.log('[Memory] Resumen de sesión guardado.');

    const factsInstruction = `
Eres un motor de extracción de información para memoria a largo plazo.
Analiza la conversación e identifica datos de interés sobre el usuario (preferencias, personas clave, tecnologías, proyectos, etc.) que sea útil recordar en el futuro.

Devuelve las actualizaciones en formato JSON estricto con la siguiente estructura:
{
  "updates": [
    { "key": "nombre_clave_min_con_guiones", "value": "valor del dato o preferencia" }
  ]
}
Si no hay información nueva o de valor real para recordar, devuelve exactamente: { "updates": [] }

Reglas críticas:
1. No te sientas obligado a inventar o forzar datos si no hay información de valor real.
2. Responde ÚNICAMENTE con el objeto JSON válido, sin bloques de código markdown ni texto adicional.
    `.trim();

    const factsRes = await callLLM(factsInstruction, `Conversación a analizar:\n${conversationText}`, false);
    const factsText = typeof factsRes === 'string' ? factsRes : factsRes.text;
    const result = parseLLMJSON(factsText);

    if (result && Array.isArray(result.updates) && result.updates.length > 0) {
      const insertFact = db.prepare('INSERT OR REPLACE INTO long_term_memory (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
      for (const update of result.updates) {
        if (update.key && update.value) {
          insertFact.run(update.key.trim().toLowerCase(), update.value.trim());
          console.log(`[Memory] Guardado en memoria a largo plazo: ${update.key} = "${update.value}"`);
        }
      }
    }

    db.prepare('DELETE FROM chat_history').run();
    console.log('[Memory] Historial de chat reciente limpiado. Sesión consolidada con éxito.');
  } catch (err) {
    console.error('[Memory] Error durante la consolidación de la sesión:', err.message);
  }
}

async function consolidateSessionIfNeeded() {
  const lastMessage = db.prepare('SELECT created_at FROM chat_history ORDER BY id DESC LIMIT 1').get();
  if (lastMessage) {
    const lastActivityTime = new Date(lastMessage.created_at.replace(' ', 'T') + 'Z').getTime();
    const diffMinutes = (Date.now() - lastActivityTime) / (1000 * 60);
    if (diffMinutes > 30) {
      await consolidateSession();
    }
  }
}

// -------------------------------------------------------------
// BUCLE PRINCIPAL DE AGENTE Y ATENCIÓN A USUARIO
// -------------------------------------------------------------

/**
 * Procesa la consulta del usuario mediante RAG contextual, bucle de ejecución de herramientas
 * resiliente con failover transparente entre proveedores, y recuperación de ejecuciones parciales.
 * @param {string} userMessage - Mensaje o comando del usuario
 * @param {object} options - Opciones adicionales (ej: onDiagnostic)
 * @returns {Promise<string>}
 */
export async function askAgent(userMessage, options = {}) {
  const onDiagnostic = options?.onDiagnostic || null;

  // 1. Consolidar sesión anterior si expiró el tiempo de inactividad
  await consolidateSessionIfNeeded();

  // 2. Guardar el nuevo mensaje del usuario en el historial de chat reciente
  db.prepare("INSERT INTO chat_history (role, content) VALUES ('user', ?)").run(userMessage);

  // 3. Recuperar historial previo para contexto y detección de proyecto
  const chatHistoryRows = db.prepare('SELECT role, content FROM chat_history ORDER BY id ASC').all();

  // 4. Detectar proyecto activo (aislamiento contextual)
  const activeProject = detectActiveProject(userMessage, chatHistoryRows);
  setActiveProjectContext(activeProject);

  if (activeProject) {
    console.log(`[Agent] Proyecto activo detectado: "${activeProject}". Aplicando aislamiento de RAG.`);
  }

  // 5. Buscar contexto de notas físicas en SQLite (RAG aislado)
  const relevantNotes = searchNotes(userMessage, activeProject);

  // Formatear el contexto de notas con límites de tamaño
  let contextText = '';
  const MAX_NOTE_CHARS = 4000;
  const MAX_TOTAL_CHARS = 16000;

  if (relevantNotes.length > 0) {
    const accumulatedText = [];
    let currentLength = 0;

    for (const note of relevantNotes) {
      if (currentLength >= MAX_TOTAL_CHARS) break;

      let noteBody = note.content || '';
      if (noteBody.length > MAX_NOTE_CHARS) {
        noteBody = noteBody.substring(0, MAX_NOTE_CHARS) + '\n... [Contenido de nota truncado por límite de tamaño]';
      }

      const projLabel = note.project ? `Proyecto: ${note.project}` : 'Transversal';
      const formattedNote = `--- NOTA: ${note.title} (ID: ${note.id}, ${projLabel}, Carpeta: ${note.folder || '.'}) ---\n${noteBody}\n----------------------------`;

      if (currentLength + formattedNote.length > MAX_TOTAL_CHARS) {
        const remainingSpace = MAX_TOTAL_CHARS - currentLength;
        if (remainingSpace > 100) {
          const cutNoteBody = noteBody.substring(0, remainingSpace - 100) + '\n... [Contenido truncado para límite global]';
          accumulatedText.push(`--- NOTA: ${note.title} (ID: ${note.id}, ${projLabel}) ---\n${cutNoteBody}\n----------------------------`);
        }
        break;
      }

      accumulatedText.push(formattedNote);
      currentLength += formattedNote.length;
    }

    contextText = accumulatedText.join('\n\n');
    console.log(`[Agent] Contexto cargado con ${accumulatedText.length} notas (${currentLength} caracteres).`);
  } else {
    contextText = 'No se encontraron notas directamente relacionadas en la base de datos.';
    console.log('[Agent] No se encontraron notas para esta consulta.');
  }

  // Historial de la conversación reciente en texto
  let chatHistoryText = '';
  if (chatHistoryRows.length > 1) {
    chatHistoryText = chatHistoryRows
      .slice(0, -1)
      .map(r => `${r.role === 'user' ? 'Usuario' : 'Asistente'}: ${r.content}`)
      .join('\n');
  }

  // Memoria a largo plazo
  const longTermMemoryRows = db.prepare('SELECT key, value FROM long_term_memory').all();
  let userProfileText = '';
  if (longTermMemoryRows.length > 0) {
    userProfileText = '\n\nInformación conocida sobre el usuario (Memoria a largo plazo):\n' + 
      longTermMemoryRows.map(r => `- ${r.key}: ${r.value}`).join('\n');
  }

  // 6. Construir instrucciones del sistema saneadas (sin taxonomía rígida ni enlazado forzado)
  const systemInstruction = `
Eres "Cerebro", un agente de IA y asistente personal. Estás alojado localmente en una Netbook y conectado a la base de datos de notas del usuario (Obsidian) y a su historial de chat.
Tu propósito es responder preguntas basándote en el contexto de notas proporcionado y ejecutar cambios en la bóveda de forma precisa y autónoma.

Reglas críticas:
1. AISLAMIENTO DE PROYECTOS: Cada subcarpeta en "proyectos/" representa un dominio de proyecto independiente. Respeta estrictamente los límites entre proyectos. NO vincules ni mezcles notas entre proyectos distintos a menos que el usuario lo pida explícitamente.
2. BANDEJA DE ENTRADA Y LIMBO: Nuevas ideas, notas rápidas o pensamientos sin proyecto asignado deben guardarse en la carpeta "limbo/". Usa la herramienta moveNote para promover notas de "limbo/" a un proyecto específico cuando el usuario lo decida.
3. GESTIÓN DE PROYECTOS: Usa listProjects para consultar los proyectos existentes y sus rutas antes de asumir nombres de carpetas.
4. ENLACES INTENCIONALES: Apoya enlaces [[WikiLinks]] explícitos pedidos por el usuario o dentro del mismo proyecto. Para conectar notas de proyectos distintos, utiliza connectNotes con allowCrossProject: true.
5. REGLA DE NO-CREACIÓN DE ÍNDICES: Está estrictamente prohibido crear notas físicas para actuar como listas, índices o resúmenes de otras notas (ej: "Proyectos Activos", "Lista de Ideas"), A MENOS que el usuario lo solicite explícitamente. Cuando el usuario pregunte por estados o listados, usa queryNotesByMetadata y responde directamente en el chat.
6. EDICIÓN LIMPIA Y METADATOS: Para cambiar estados de avance o categorías, usa updateNoteMetadata. Para actualizar listas o tablas existentes dentro de una nota, usa replaceNoteSection en lugar de anexar encabezados repetidos al final.
7. HERRAMIENTAS ACTIVAS: Tienes a tu disposición: createNote, moveNote, listProjects, appendNoteContent, connectNotes, listNotes, queryNotesByMetadata, updateNoteMetadata, replaceNoteSection, readNote, deleteNote. Úsalas activamente en lugar de solo simular en texto que realizaste los cambios.
8. CONCISIÓN Y RESPUESTAS DIRECTAS: Responde siempre en español, de forma concisa y directa. Ejecuta las herramientas requeridas directamente sin monólogos ni razonamientos internos innecesarios. Sin llamadas a la acción genéricas ni despedidas de cortesía repetitivas.${userProfileText}
  `.trim();

  // 7. Prompt estructurado para el turno
  const prompt = `
Contexto del usuario (Notas recuperadas):
${contextText}

${chatHistoryText ? `Historial de la conversación reciente:\n${chatHistoryText}\n` : ''}

Usuario: "${userMessage}"
  `.trim();

  // 8. Bucle conversacional con recuperación mid-turn
  const executedActions = [];
  let answer = '';
  let loopCount = 0;
  const maxTurns = 8;

  // Estado universal: inicializamos con mensaje user
  let geminiContents = [
    { role: 'user', parts: [{ text: prompt }] }
  ];

  try {
    while (loopCount < maxTurns) {
      console.log(`[Agent] Turno de ejecución ${loopCount + 1}/${maxTurns}...`);
      
      const responseData = await callLLM(systemInstruction, geminiContents, true, onDiagnostic);

      if (responseData.toolCalls && responseData.toolCalls.length > 0) {
        // Incorporar respuesta del modelo al historial de Gemini
        if (responseData.rawCandidate) {
          geminiContents.push(responseData.rawCandidate);
        } else {
          geminiContents.push({
            role: 'model',
            parts: responseData.toolCalls.map(c => ({
              functionCall: { name: c.name, args: c.args }
            }))
          });
        }

        const functionResponseParts = [];

        for (const call of responseData.toolCalls) {
          const { name, args } = call;
          console.log(`[Agent] Ejecutando herramienta local "${name}" con args:`, args);
          const action = toolActions[name];
          let toolResponse;

          try {
            if (action) {
              toolResponse = await action(args);
            } else {
              toolResponse = { success: false, error: `Herramienta ${name} no encontrada.` };
            }
          } catch (execErr) {
            toolResponse = { success: false, error: execErr.message };
          }

          console.log(`[Agent] Resultado de "${name}":`, toolResponse);

          // Registrar acción ejecutada con éxito para trazabilidad y partial recovery
          if (toolResponse.success) {
            executedActions.push({
              name,
              args,
              summary: toolResponse.message || (toolResponse.note?.title ? `Nota "${toolResponse.note.title}"` : null)
            });
          }

          functionResponseParts.push({
            functionResponse: {
              name,
              response: toolResponse
            }
          });
        }

        geminiContents.push({
          role: 'function',
          parts: functionResponseParts
        });

        loopCount++;
      } else {
        answer = responseData.text;
        break;
      }
    }

    if (loopCount === maxTurns && !answer) {
      console.warn('[Agent] Se alcanzó el número máximo de turnos sin respuesta final.');
      const limitInstruction = `${systemInstruction}\n\nIMPORTANTE: Se alcanzó el límite máximo de ${maxTurns} acciones. NO ejecutes más herramientas. Haz un resumen conciso en español de los cambios realizados.`;
      const finalRes = await callLLM(limitInstruction, geminiContents, false, onDiagnostic);
      answer = typeof finalRes === 'string' ? finalRes : finalRes.text;
    }
  } catch (fatalError) {
    console.error('[Agent] Error crítico en el ciclo de ejecución de IA:', fatalError.message);

    // Recuperación de ejecución parcial (Mid-Turn Recovery)
    if (executedActions.length > 0) {
      answer = [
        '✅ Se completaron las siguientes acciones en tu bóveda:',
        ...executedActions.map(a => `- ${a.name}: ${a.summary || JSON.stringify(a.args)}`),
        '',
        '⚠️ La respuesta conversacional final no pudo completarse debido a una indisponibilidad temporal de los proveedores de IA. Los cambios se guardaron correctamente.'
      ].join('\n');
    } else {
      answer = `⚠️ No fue posible procesar tu solicitud debido a una indisponibilidad temporal en los servicios de IA (${fatalError.message}). Por favor, intenta de nuevo en unos momentos.`;
    }
  }

  if (!answer || !answer.trim()) {
    if (executedActions.length > 0) {
      answer = '✅ Acciones completadas correctamente en la bóveda.';
    } else {
      answer = '✅ He completado el procesamiento de la consulta.';
    }
  }

  // 9. Guardar la respuesta final en el historial de chat
  db.prepare("INSERT INTO chat_history (role, content) VALUES ('assistant', ?)").run(answer);

  return answer;
}
