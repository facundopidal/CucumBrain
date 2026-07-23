import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Transcribe un archivo de audio local (.ogg) de forma polimórfica según la configuración.
 * @param {string} filePath - Ruta absoluta del archivo a transcribir
 * @returns {Promise<string>} - Texto transcrito
 */
export async function transcribeAudio(filePath) {
  const provider = (process.env.TRANSCRIPTION_PROVIDER || process.env.LLM_PROVIDER || 'gemini').toLowerCase();

  // 1. Caso Deepgram (Nova-2)
  if (provider === 'deepgram') {
    const apiKey = process.env.TRANSCRIPTION_API_KEY || process.env.LLM_API_KEY;
    if (!apiKey) {
      throw new Error('Falta configurar la clave API para Deepgram (definir TRANSCRIPTION_API_KEY en .env)');
    }

    console.log('[Transcriber] Iniciando transcripción con Deepgram (Nova-2)...');
    const audioBuffer = fs.readFileSync(filePath);

    // Endpoint recomendado de Deepgram con formato inteligente y español
    const url = 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=es';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'audio/ogg'
      },
      body: audioBuffer
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Error en API de Deepgram (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    return transcript.trim();
  }

  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(`Falta configurar la clave API para el proveedor: ${provider} (definir LLM_API_KEY o GEMINI_API_KEY en .env)`);
  }

  console.log(`[Transcriber] Iniciando transcripción con el proveedor: ${provider}...`);

  // 2. Caso Gemini Nativo (Usa inlineData)
  if (provider === 'gemini') {
    const modelName = process.env.LLM_MODEL || 'gemini-3.5-flash';
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const audioBuffer = fs.readFileSync(filePath);
    const base64Audio = audioBuffer.toString('base64');

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64Audio,
          mimeType: 'audio/ogg'
        }
      },
      'Transcribe el siguiente audio a texto en español de manera exacta, sin agregar ningún comentario, traducción, ni aclaración por tu parte. Solo devuelve el texto hablado.'
    ]);

    const text = result.response.text();
    return text.trim();
  }

  // 2. OpenAI / Groq / Whisper API REST
  let audioUrl = process.env.LLM_AUDIO_URL;
  let modelName = process.env.LLM_AUDIO_MODEL;

  if (provider === 'groq') {
    audioUrl = audioUrl || 'https://api.groq.com/openai/v1/audio/transcriptions';
    modelName = modelName || 'whisper-large-v3';
  } else if (provider === 'openrouter') {
    audioUrl = audioUrl || 'https://openrouter.ai/api/v1/audio/transcriptions';
    modelName = modelName || 'openai/whisper-large-v3'; // o el modelo preferido
  } else {
    // Fallback estándar de OpenAI si no está especificado
    audioUrl = audioUrl || 'https://api.openai.com/v1/audio/transcriptions';
    modelName = modelName || 'whisper-1';
  }

  const audioBuffer = fs.readFileSync(filePath);
  const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });

  const formData = new FormData();
  formData.append('file', audioBlob, 'voice.ogg');
  formData.append('model', modelName);
  formData.append('language', 'es'); // Forzar transcripción en español

  const headers = {
    'Authorization': `Bearer ${apiKey}`
  };

  const response = await fetch(audioUrl, {
    method: 'POST',
    headers: headers,
    body: formData
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error en API de transcripción (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}
