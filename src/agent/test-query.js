import 'dotenv/config';
import { askAgent } from './agent.js';

// Usar el primer argumento de la línea de comandos o una pregunta de prueba
const query = process.argv.slice(2).join(' ') || '¿Qué tareas tengo pendientes en mi proyecto de SEO?';

console.log(`\n=== Preguntando a Cerebro ===`);
console.log(`Pregunta: "${query}"\n`);

try {
  const answer = await askAgent(query);
  console.log(`=== Respuesta del Agente ===`);
  console.log(answer);
  console.log(`============================\n`);
} catch (error) {
  console.error(`[Test] Error al consultar al agente:`, error.message);
}
