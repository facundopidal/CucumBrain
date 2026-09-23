import 'dotenv/config';
import { ensureVaultIndexed } from './database/indexer.js';
import './watcher/watcher.js';
import './bot/bot.js';

console.log('¡CucumBrain iniciado (Watcher + Bot de Telegram)!');

// Auto-hydration asíncrona de notas existentes al iniciar
ensureVaultIndexed().catch(err => {
  console.error('[Index] Error en auto-hydration de bóveda:', err.message);
});
