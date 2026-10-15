import { Telegraf } from 'telegraf';
import { askAgent } from '../agent/agent.js';
import db from '../database/db.js';
import { downloadTelegramFile, cleanTempFile } from '../utils/audio.js';
import { transcribeAudio } from '../utils/transcriber.js';

export function markdownToTelegramHtml(markdown) {
  if (!markdown) return '';
  let html = markdown;

  // 1. Escapar caracteres HTML reservados para evitar sintaxis inválida
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 2. Convertir bloques de código ```code```
  html = html.replace(/```(?:[a-z]+)?\n?([\s\S]*?)```/gi, (match, code) => {
    return `<pre>${code}</pre>`;
  });

  // 3. Convertir código inline `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 4. Convertir negrita **texto** o __texto__
  html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__(.*?)__/g, '<b>$1</b>');

  // 5. Convertir cursiva *texto*
  html = html.replace(/(?<!\*)\*([^\*\n]+)\*(?!\*)/g, '<i>$1</i>');

  // 6. Convertir encabezados #, ##, ### a negrita destacada
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 7. Resaltar WikiLinks [[Nota]]
  html = html.replace(/\[\[(.*?)\]\]/g, '<b>[[ $1 ]]</b>');

  return html;
}

/**
 * Crea un manejador para enviar notificaciones de diagnóstico en tiempo real al chat de Telegram
 * cuando ocurren reintentos con backoff o cambios de proveedor LLM (fallback).
 */
function createDiagnosticHandler(ctx) {
  return async (diagMessage) => {
    try {
      await ctx.reply(diagMessage);
    } catch {
      console.warn('[Diagnostic] No se pudo enviar una notificación de diagnóstico.');
    }
  };
}

export function createBotRuntime({ withRequestLifecycle, onUpdate = () => {}, onError = () => {} } = {}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!botToken) {
    console.warn('[Bot] TELEGRAM_BOT_TOKEN no configurada. El bot de Telegram no se iniciará.');
    return { bot: null, stop() {} };
  }

  const bot = new Telegraf(botToken);
  const runLifecycle = (kind, operation, ctx) => typeof withRequestLifecycle === 'function'
    ? withRequestLifecycle(kind, operation, ctx)
    : operation(null);

  bot.catch((error, ctx) => {
    if (error && typeof error === 'object') error.updateHandlerFailure = true;
    console.warn('[Bot] Falló el procesamiento de una actualización.');
    try { onError(error, ctx); } catch {}
  });

  // Middleware de seguridad para filtrar ID del usuario
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!allowedUser) {
      console.warn(`[Bot] TELEGRAM_ALLOWED_USER_ID no configurado. Mensaje ignorado por seguridad.`);
      return;
    }
    if (String(userId) !== String(allowedUser)) {
      console.warn('[Bot] Acceso no autorizado denegado.');
      // Ignoramos el mensaje para no dar pistas de que hay un bot activo
      return;
    }
    const result = await next();
    onUpdate();
    return result;
  });

  // Comando de inicio
  bot.start((ctx) => runLifecycle('command', async () => {
    return ctx.reply('🧠 ¡Hola! Soy Cerebro, tu asistente personal conectado a tus notas de Obsidian.\n\nEscríbeme cualquier consulta sobre tus pensamientos o proyectos, o usa el comando /status para ver cómo está tu base de conocimientos.');
  }, ctx));

  // Comando de estado
  bot.command('status', (ctx) => runLifecycle('command', async () => {
    try {
      const notesCount = db.prepare("SELECT COUNT(*) as count FROM notes WHERE status != 'stub'").get().count;
      const stubsCount = db.prepare("SELECT COUNT(*) as count FROM notes WHERE status = 'stub'").get().count;
      const typesCount = db.prepare("SELECT COUNT(*) as count FROM types").get().count;
      
      return ctx.reply(
        `📊 *Estado de CucumBrain:*\n\n` +
        `📝 Notas indexadas: *${notesCount}*\n` +
        `🔗 Enlaces huérfanos (stubs): *${stubsCount}*\n` +
        `📁 Categorías activas: *${typesCount}*`, 
        { parse_mode: 'Markdown' }
      );
    } catch {
      console.error('[Bot] Error en comando /status.');
      return ctx.reply('❌ Error al recuperar el estado de la base de datos.');
    }
  }, ctx));

  async function replyLongMessage(ctx, text, options = {}) {
    if (!text || !text.trim()) {
      text = '✅ Operación completada.';
    }

    const sendChunk = async (plainChunk, htmlChunk) => {
      try {
        await ctx.reply(htmlChunk, { parse_mode: 'HTML', ...options });
      } catch {
        console.warn('[Bot] Falló el formato HTML en Telegram; se intentará texto plano.');
        await ctx.reply(plainChunk, options);
      }
    };

    const MAX_LENGTH = 3800;
    const htmlFormatted = markdownToTelegramHtml(text);

    if (text.length <= MAX_LENGTH && htmlFormatted.length <= MAX_LENGTH) {
      return sendChunk(text, htmlFormatted);
    }

    const chunksText = [];
    const chunksHtml = [];
    let currentText = text;
    let currentHtml = htmlFormatted;

    while (currentText.length > 0) {
      if (currentText.length <= MAX_LENGTH) {
        chunksText.push(currentText);
        chunksHtml.push(currentHtml);
        break;
      }

      let cutIndex = currentText.lastIndexOf('\n', MAX_LENGTH);
      if (cutIndex <= 0) {
        cutIndex = MAX_LENGTH;
      }

      chunksText.push(currentText.substring(0, cutIndex));
      chunksHtml.push(currentHtml.substring(0, cutIndex));

      currentText = currentText.substring(cutIndex).trimStart();
      currentHtml = currentHtml.substring(cutIndex).trimStart();
    }

    for (let i = 0; i < chunksText.length; i++) {
      await sendChunk(chunksText[i], chunksHtml[i]);
    }
  }

  // Manejador de mensajes de texto (Inferencia RAG con diagnóstico)
  bot.on('text', async (ctx) => runLifecycle('text', async () => {
    const userMessage = ctx.message.text;

    try {
      // Indicar que el bot está escribiendo
      await ctx.sendChatAction('typing');

      // Consultar al agente de IA con handler de diagnóstico
      const onDiagnostic = createDiagnosticHandler(ctx);
      const answer = await askAgent(userMessage, { onDiagnostic });

      // Responder al usuario (usando división para mensajes largos)
      await replyLongMessage(ctx, answer);
    } catch (err) {
      console.error('[Bot] Error al procesar mensaje.');
      await ctx.reply('❌ Hubo un error al procesar tu consulta. Inténtalo de nuevo más tarde.');
      throw err;
    }
  }, ctx));

  // Manejador de mensajes de voz (Audio a texto y luego a askAgent con diagnóstico)
  bot.on('voice', async (ctx) => runLifecycle('audio', async () => {
    const fileId = ctx.message.voice.file_id;

    let tempFilePath = null;
    try {
      // Indicar que el bot está procesando el audio
      await ctx.reply('🎙️ Procesando audio...');
      await ctx.sendChatAction('record_voice');

      // 1. Obtener el link de descarga desde Telegram
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const downloadUrl = fileLink.href;

      // 2. Descargar el archivo de audio localmente
      const fileName = `voice-${Date.now()}.ogg`;
      tempFilePath = await downloadTelegramFile(downloadUrl, fileName);

      // 3. Transcribir el audio
      await ctx.sendChatAction('typing');
      const transcription = await transcribeAudio(tempFilePath);
      
      if (!transcription || transcription.trim() === '') {
        await ctx.reply('⚠️ No logré escuchar con claridad el audio. Asegúrate de hablar claro o de que no esté vacío.');
        return;
      }

      await ctx.reply(`📝 *Transcribí:* "${transcription}"`, { parse_mode: 'Markdown' });

      // Indicar que el bot está respondiendo
      await ctx.sendChatAction('typing');

      // 4. Consultar al agente con el texto transcrito y diagnóstico
      const onDiagnostic = createDiagnosticHandler(ctx);
      const answer = await askAgent(transcription, { onDiagnostic });

      // 5. Responder al usuario (usando división para mensajes largos)
      await replyLongMessage(ctx, answer);
    } catch (err) {
      console.error('[Bot] Error al procesar nota de voz.');
      await ctx.reply('❌ Error al procesar el mensaje de voz. Inténtalo de nuevo más tarde.');
      throw err;
    } finally {
      // 6. Limpiar el archivo de audio temporal
      if (tempFilePath) {
        cleanTempFile(tempFilePath);
      }
    }
  }, ctx));

  return { bot, stop: (reason = 'guardian-shutdown') => bot.stop(reason) };
}
