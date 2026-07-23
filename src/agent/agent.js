import { GoogleGenerativeAI } from '@google/generative-ai';
import db from '../database/db.js';
import { toolActions, getToolsSchemaForProvider } from './tools.js';

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

/**
 * Busca notas relevantes en la base de datos basándose en el mensaje del usuario.
 * Extrae palabras clave del mensaje y busca coincidencias en título, contenido o ID.
 */
function searchNotes(message) {
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
    const rows = db.prepare(`
      SELECT id, title, type_id, status, content, importance 
      FROM notes 
      WHERE status != 'stub' 
        AND (title LIKE ? OR content LIKE ? OR id LIKE ?)
    `).all(queryTerm, queryTerm, queryTerm);

    for (const row of rows) {
      if (!resultsMap.has(row.id)) {
        resultsMap.set(row.id, { ...row, score: 0 });
      }
      const note = resultsMap.get(row.id);
      note.score += (row.importance || 3);
    }
  }

  return Array.from(resultsMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * Función genérica y polimórfica para realizar llamadas a LLMs.
 * Soporta 'gemini' nativo, y proveedores OpenAI-compatibles como 'openrouter' y 'groq' vía fetch.
 * 
 * Si `useTools` es true, devuelve un objeto con el texto y las llamadas a herramientas (si las hay).
 */
export async function callLLM(systemInstruction, promptOrMessages, useTools = false) {
  let provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (provider === 'grok') provider = 'groq';
  const modelName = process.env.LLM_MODEL || (provider === 'groq' ? 'llama-3.3-70b-versatile' : 'gemini-1.5-flash');
  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(`Falta configurar la clave API para el proveedor: ${provider} (definir LLM_API_KEY o GEMINI_API_KEY en .env)`);
  }

  const isGemini = provider === 'gemini';

  // 1. Caso Gemini Nativo
  if (isGemini) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelConfig = { 
      model: modelName,
      systemInstruction: systemInstruction
    };
    
    if (useTools) {
      modelConfig.tools = [{ functionDeclarations: getToolsSchemaForProvider('gemini') }];
    }
    
    const model = genAI.getGenerativeModel(modelConfig);
    
    let result;
    if (Array.isArray(promptOrMessages)) {
      result = await model.generateContent({ contents: promptOrMessages });
    } else {
      result = await model.generateContent(promptOrMessages);
    }
    
    const response = await result.response;
    const functionCalls = (typeof response.functionCalls === 'function') 
      ? response.functionCalls() 
      : response.functionCalls;
      
    if (useTools) {
      return {
        text: response.text ? response.text() : '',
        toolCalls: functionCalls,
        response: response
      };
    } else {
      return response.text();
    }
  }

  // 2. Proveedores con compatibilidad de API OpenAI (OpenRouter, Groq, etc.)
  let url = '';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['HTTP-Referer'] = 'https://github.com/user/cucumbrain';
    headers['X-Title'] = 'CucumBrain';
  } else if (provider === 'groq') {
    url = 'https://api.groq.com/openai/v1/chat/completions';
  } else if (provider === 'custom') {
    url = process.env.LLM_API_URL || '';
  } else {
    throw new Error(`Proveedor de LLM no soportado o mal configurado: ${provider}`);
  }

  // Construir mensajes para OpenAI
  let messages = [];
  if (Array.isArray(promptOrMessages)) {
    messages = [
      { role: 'system', content: systemInstruction },
      ...promptOrMessages
    ];
  } else {
    messages = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: promptOrMessages }
    ];
  }

  const payload = {
    model: modelName,
    messages: messages,
    max_tokens: Number(process.env.LLM_MAX_TOKENS) || 4000
  };

  if (useTools) {
    payload.tools = getToolsSchemaForProvider(provider).map(schema => ({
      type: 'function',
      function: schema
    }));
    payload.tool_choice = 'auto';
  }

  console.log(`[LLM] Enviando petición a ${provider} usando el modelo ${modelName}...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error en la API de ${provider} (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  if (choice && choice.message) {
    if (useTools) {
      return {
        text: choice.message.content || '',
        toolCalls: choice.message.tool_calls,
        message: choice.message
      };
    } else {
      return choice.message.content;
    }
  } else {
    throw new Error(`Respuesta inválida o vacía de la API de ${provider}`);
  }
}

/**
 * Parsea de forma segura una respuesta JSON devuelta por la IA, limpiando posibles bloques de código.
 */
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

/**
 * Consolida la sesión de chat activa: genera un resumen del diálogo
 * y extrae datos clave a largo plazo para limpiar el historial reciente.
 */
async function consolidateSession() {
  console.log('[Memory] Iniciando consolidación de la sesión de chat anterior...');

  // 1. Recuperar la conversación de la sesión activa
  const history = db.prepare('SELECT role, content FROM chat_history ORDER BY id ASC').all();
  
  // Evitar consolidar sesiones vacías o sin respuestas del asistente
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
    // 2. Generar el resumen de la sesión
    const summaryInstruction = 'Eres un motor de consolidación de memoria. Escribe un resumen sumamente conciso, estructurado y en español de la conversación provista. Enfócate en decisiones tomadas, temas de interés y pendientes del usuario.';
    let summary = await callLLM(summaryInstruction, `Conversación a resumir:\n${conversationText}`);
    if (!summary || !summary.trim()) {
      summary = 'Sesión conversacional de rutina sin decisiones o temas clave pendientes registrados.';
    }
    
    // Guardar el resumen en SQLite
    db.prepare('INSERT INTO session_summaries (summary) VALUES (?)').run(summary);
    console.log('[Memory] Resumen de sesión guardado.');

    // 3. Extraer hechos y preferencias a largo plazo (formato JSON)
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

    const factsResponse = await callLLM(factsInstruction, `Conversación a analizar:\n${conversationText}`);
    const result = parseLLMJSON(factsResponse);

    if (result && Array.isArray(result.updates) && result.updates.length > 0) {
      const insertFact = db.prepare('INSERT OR REPLACE INTO long_term_memory (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
      for (const update of result.updates) {
        if (update.key && update.value) {
          insertFact.run(update.key.trim().toLowerCase(), update.value.trim());
          console.log(`[Memory] Guardado en memoria a largo plazo: ${update.key} = "${update.value}"`);
        }
      }
    } else {
      console.log('[Memory] No se detectaron hechos nuevos para la memoria a largo plazo.');
    }

    // 4. Limpiar el historial reciente una vez consolidado
    db.prepare('DELETE FROM chat_history').run();
    console.log('[Memory] Historial de chat reciente limpiado. Sesión consolidada con éxito.');
  } catch (err) {
    console.error('[Memory] Error durante la consolidación de la sesión:', err.message);
  }
}

/**
 * Comprueba si la última interacción fue hace más de 30 minutos y, si es así, consolida la sesión.
 */
async function consolidateSessionIfNeeded() {
  const lastMessage = db.prepare('SELECT created_at FROM chat_history ORDER BY id DESC LIMIT 1').get();
  
  if (lastMessage) {
    // Convertir la fecha UTC almacenada por SQLite
    const lastActivityTime = new Date(lastMessage.created_at.replace(' ', 'T') + 'Z').getTime();
    const diffMinutes = (Date.now() - lastActivityTime) / (1000 * 60);

    if (diffMinutes > 30) {
      await consolidateSession();
    }
  }
}

/**
 * Envía la pregunta del usuario al agente de IA enriquecida con el contexto de las notas y memoria del chat.
 * @param {string} userMessage - Mensaje/pregunta del usuario
 * @returns {Promise<string>} Respuesta generada por la IA
 */
export async function askAgent(userMessage) {
  // 1. Consolidar sesión anterior si expiró el tiempo de inactividad
  await consolidateSessionIfNeeded();

  // 2. Guardar el nuevo mensaje del usuario en el historial de chat reciente
  db.prepare("INSERT INTO chat_history (role, content) VALUES ('user', ?)").run(userMessage);

  // 3. Buscar contexto de notas físicas en SQLite (RAG)
  const relevantNotes = searchNotes(userMessage);
  
  // Formatear el contexto de notas con límites de tamaño
  let contextText = '';
  const MAX_NOTE_CHARS = 4000;
  const MAX_TOTAL_CHARS = 16000;
  
  if (relevantNotes.length > 0) {
    let accumulatedText = [];
    let currentLength = 0;
    
    for (const note of relevantNotes) {
      if (currentLength >= MAX_TOTAL_CHARS) break;
      
      let noteBody = note.content || '';
      if (noteBody.length > MAX_NOTE_CHARS) {
        noteBody = noteBody.substring(0, MAX_NOTE_CHARS) + '\n... [Contenido de nota truncado por límite de tamaño]';
      }
      
      const formattedNote = `--- NOTA: ${note.title} (ID: ${note.id}, Tipo: ${note.type_id}) ---\n${noteBody}\n----------------------------`;
      
      if (currentLength + formattedNote.length > MAX_TOTAL_CHARS) {
        const remainingSpace = MAX_TOTAL_CHARS - currentLength;
        if (remainingSpace > 100) {
          const cutNoteBody = noteBody.substring(0, remainingSpace - 100) + '\n... [Contenido de nota truncado para ajustar al contexto global]';
          accumulatedText.push(`--- NOTA: ${note.title} (ID: ${note.id}, Tipo: ${note.type_id}) ---\n${cutNoteBody}\n----------------------------`);
        }
        break;
      }
      
      accumulatedText.push(formattedNote);
      currentLength += formattedNote.length;
    }
    
    contextText = accumulatedText.join('\n\n');
    console.log(`[Agent] Contexto cargado y recortado a ${accumulatedText.length} notas (${currentLength} caracteres).`);
  } else {
    contextText = 'No se encontraron notas directamente relacionadas en la base de datos.';
    console.log('[Agent] No se encontraron notas para esta consulta.');
  }

  // 4. Recuperar historial de chat de la sesión activa
  const chatHistoryRows = db.prepare('SELECT role, content FROM chat_history ORDER BY id ASC').all();
  let chatHistoryText = '';
  if (chatHistoryRows.length > 1) {
    // Convertimos el historial (excepto el último mensaje recién agregado) en texto legible
    chatHistoryText = chatHistoryRows
      .slice(0, -1)
      .map(r => `${r.role === 'user' ? 'Usuario' : 'Asistente'}: ${r.content}`)
      .join('\n');
  }

  // 5. Recuperar la memoria a largo plazo (datos conocidos sobre el usuario)
  const longTermMemoryRows = db.prepare('SELECT key, value FROM long_term_memory').all();
  let userProfileText = '';
  if (longTermMemoryRows.length > 0) {
    userProfileText = '\n\nInformación conocida sobre el usuario (Memoria a largo plazo):\n' + 
      longTermMemoryRows.map(r => `- ${r.key}: ${r.value}`).join('\n');
  }

  // 6. Construir las instrucciones de sistema
  const systemInstruction = `
Eres "Cerebro", un agente de IA y asistente personal. Estás alojado localmente en una Netbook y conectado a la base de datos de notas del usuario (Obsidian) y a su historial de chat.
Tu propósito es responder preguntas basándote en el contexto de notas proporcionado y guiar al usuario.

Reglas críticas:
1. Si el contexto contiene información que responda a la pregunta, úsala con precisión.
2. Si el contexto es insuficiente o no está relacionado, responde basándote en tu conocimiento general, pero aclara amigablemente que no encontraste notas específicas sobre ese tema.
3. Mantén tus respuestas concisas, estructuradas y en español.
4. Si haces referencia a una nota del contexto, menciónala usando el formato [[Nombre de la Nota]] (ej: [[Mi Nota]]).
5. Tienes herramientas a tu disposición (createNote, appendNoteContent, connectNotes, listNotes, queryNotesByMetadata, updateNoteMetadata, replaceNoteSection, readNote, deleteNote). Úsalas activamente en lugar de solo simular en texto que realizaste los cambios. Si necesitas leer el contenido completo de una nota específica que no viene en el contexto, usa readNote. Si el usuario te pide eliminar una nota, usa deleteNote.
6. REGLA DE NO-CREACIÓN DE ÍNDICES: Está estrictamente prohibido crear notas físicas para actuar como listas, índices o resúmenes de otras notas (ej: "Proyectos Activos", "Lista de Ideas"), A MENOS que el usuario lo solicite explícitamente. Cuando el usuario pregunte por estados o listados, debes usar queryNotesByMetadata y responder directamente en el chat en texto.
7. EDICIÓN LIMPIA Y METADATOS: Para cambiar estados de avance o categorías, usa updateNoteMetadata. Para actualizar listas o tablas existentes dentro de una nota, usa replaceNoteSection en lugar de anexar encabezados repetidos al final.
8. SEMÁNTICA Y GRAFO RELACIONAL: Comprende que "proyectos" se refiere a desarrollos/automatizaciones que se conectan con "ideas", "preocupaciones/frustraciones", "disponibilidad de tiempo" y "economía". Al registrar o modificar ideas, usa connectNotes para tejer relaciones proactivas con estos dominios.
9. IDIOMA Y SÍNTESIS DIRECTA: Está estrictamente prohibido responder en inglés o imprimir razonamientos/pensamientos internos. Todas las respuestas deben ser en español, breves y con las herramientas ejecutadas directamente.${userProfileText}
  `.trim();

  // 7. Construir el prompt de usuario (combinando contexto, historial y mensaje actual)
  const prompt = `
Contexto del usuario (Notas recuperadas):
${contextText}

${chatHistoryText ? `Historial de la conversación reciente:\n${chatHistoryText}\n` : ''}

Usuario: "${userMessage}"
  `.trim();

  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const isGemini = provider === 'gemini';

  let answer = '';
  let loopCount = 0;
  const maxTurns = 8;

  if (isGemini) {
    let contents = [
      { role: 'user', parts: [{ text: prompt }] }
    ];

    while (loopCount < maxTurns) {
      console.log(`[Agent] Turno de herramienta ${loopCount + 1}/${maxTurns} para Gemini...`);
      const responseData = await callLLM(systemInstruction, contents, true);

      if (responseData.toolCalls && responseData.toolCalls.length > 0) {
        // Preservar exactamente los parts devueltos por el modelo (incluyendo thought_signature si existen)
        const candidateContent = responseData.response?.candidates?.[0]?.content;
        if (candidateContent && candidateContent.parts) {
          contents.push(candidateContent);
        } else {
          contents.push({
            role: 'model',
            parts: responseData.toolCalls.map(call => ({
              functionCall: {
                name: call.name,
                args: call.args
              }
            }))
          });
        }

        const functionResponseParts = [];
        for (const call of responseData.toolCalls) {
          const { name, args } = call;
          console.log(`[Agent] Ejecutando herramienta local ${name} con argumentos:`, args);
          const action = toolActions[name];
          let toolResponse;
          if (action) {
            toolResponse = await action(args);
          } else {
            toolResponse = { success: false, error: `Herramienta ${name} no encontrada.` };
          }
          console.log(`[Agent] Resultado de herramienta ${name}:`, toolResponse);

          functionResponseParts.push({
            functionResponse: {
              name: name,
              response: toolResponse
            }
          });
        }

        contents.push({
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
      console.warn('[Agent] Se alcanzó el número máximo de turnos de herramientas sin respuesta final.');
      const limitInstruction = `${systemInstruction}\n\nIMPORTANTE: Se alcanzó el límite máximo de ${maxTurns} acciones en este turno. NO intentes ejecutar más herramientas. Haz un resumen amigable en español de los cambios que lograste realizar y pregúntale al usuario si desea continuar con las tareas pendientes.`;
      const responseData = await callLLM(limitInstruction, contents, false);
      answer = responseData;
    }
  } else {
    // OpenAI/OpenRouter/Groq
    let messages = [
      { role: 'user', content: prompt }
    ];

    while (loopCount < maxTurns) {
      console.log(`[Agent] Turno de herramienta ${loopCount + 1}/${maxTurns} para ${provider}...`);
      const responseData = await callLLM(systemInstruction, messages, true);

      if (responseData.toolCalls && responseData.toolCalls.length > 0) {
        // Añadir el mensaje del asistente a la lista de mensajes
        messages.push(responseData.message);

        // Procesar las respuestas de herramientas y añadirlas
        for (const toolCall of responseData.toolCalls) {
          const name = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`[Agent] Ejecutando herramienta local ${name} con argumentos:`, args);
          const action = toolActions[name];
          let toolResponse;
          if (action) {
            toolResponse = await action(args);
          } else {
            toolResponse = { success: false, error: `Herramienta ${name} no encontrada.` };
          }
          console.log(`[Agent] Resultado de herramienta ${name}:`, toolResponse);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: name,
            content: JSON.stringify(toolResponse)
          });
        }

        loopCount++;
      } else {
        answer = responseData.text;
        break;
      }
    }

    if (loopCount === maxTurns && !answer) {
      console.warn('[Agent] Se alcanzó el número máximo de turnos de herramientas sin respuesta final.');
      const limitInstruction = `${systemInstruction}\n\nIMPORTANTE: Se alcanzó el límite máximo de ${maxTurns} acciones en este turno. NO intentes ejecutar más herramientas. Haz un resumen amigable en español de los cambios que lograste realizar y pregúntale al usuario si desea continuar con las tareas pendientes.`;
      const responseData = await callLLM(limitInstruction, messages, false);
      answer = responseData;
    }
  }

  if (!answer || !answer.trim()) {
    answer = '✅ He completado el procesamiento de las notas. ¿Hay algún detalle específico que quieras ajustar?';
  }

  // 9. Guardar la respuesta final del asistente en el historial de chat reciente
  db.prepare("INSERT INTO chat_history (role, content) VALUES ('assistant', ?)").run(answer);

  return answer;
}
