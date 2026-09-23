import assert from 'assert';
import { 
  convertGeminiToOpenAIMessages, 
  convertOpenAIToGeminiContents, 
  executeWithRetry 
} from '../src/agent/agent.js';

console.log('=== TEST FASE 4 / E2E: Motor de Resiliencia, Conversores y Fallback ===');

// 1. Probar conversores de formato bidireccionales
console.log('\n--- Probando conversores de formato (Gemini <-> OpenAI) ---');

const sampleGeminiContents = [
  {
    role: 'user',
    parts: [{ text: 'Mueve la nota Boceto a proyectos/TaPeer' }]
  },
  {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'moveNote',
          args: { title: 'Boceto', targetFolder: 'proyectos/TaPeer' }
        }
      }
    ]
  },
  {
    role: 'function',
    parts: [
      {
        functionResponse: {
          name: 'moveNote',
          response: { success: true, message: 'Nota movida exitosamente.' }
        }
      }
    ]
  }
];

const openAiMsgs = convertGeminiToOpenAIMessages('Eres un asistente.', sampleGeminiContents);
assert.strictEqual(openAiMsgs[0].role, 'system', 'Debe comenzar con system instruction');
assert.strictEqual(openAiMsgs[1].role, 'user', 'El segundo mensaje debe ser user');
assert.strictEqual(openAiMsgs[2].role, 'assistant', 'El tercer mensaje debe ser assistant con tool_calls');
assert(openAiMsgs[2].tool_calls.length === 1, 'Debe contener 1 tool_call');
assert.strictEqual(openAiMsgs[2].tool_calls[0].function.name, 'moveNote');
assert.strictEqual(openAiMsgs[3].role, 'tool', 'El cuarto mensaje debe ser role tool');
console.log('✅ convertGeminiToOpenAIMessages convirtió correctamente llamadas a herramientas y respuestas.');

const roundTripGemini = convertOpenAIToGeminiContents(openAiMsgs);
assert.strictEqual(roundTripGemini[0].role, 'user');
assert.strictEqual(roundTripGemini[1].role, 'model');
assert(roundTripGemini[1].parts[0].functionCall, 'Debe contener functionCall en parts');
assert.strictEqual(roundTripGemini[2].role, 'function');
assert(roundTripGemini[2].parts[0].functionResponse, 'Debe contener functionResponse en parts');
console.log('✅ convertOpenAIToGeminiContents convirtió de vuelta a formato Gemini sin pérdida de estructura.');

// 2. Probar executeWithRetry con error transitorio recuperable (503)
console.log('\n--- Probando executeWithRetry con recuperación de 503 ---');
let attempts503 = 0;
const diagnosticsEmitted = [];
const mockTransientFn = async () => {
  attempts503++;
  if (attempts503 < 3) {
    const err = new Error('Service Unavailable');
    err.status = 503;
    throw err;
  }
  return { success: true, attempt: attempts503 };
};

const retryResult = await executeWithRetry(mockTransientFn, {
  maxRetries: 3,
  providerName: 'Gemini',
  modelName: 'gemini-3.1-flash-lite',
  onDiagnostic: (msg) => diagnosticsEmitted.push(msg)
});

assert.strictEqual(retryResult.success, true);
assert.strictEqual(retryResult.attempt, 3);
assert.strictEqual(diagnosticsEmitted.length, 2, 'Debió emitir 2 diagnósticos de reintento');
console.log('✅ executeWithRetry se recuperó exitosamente tras 2 fallos transitorios.');
console.log('Diagnósticos capturados:', diagnosticsEmitted);

// 3. Probar executeWithRetry con error no recuperable (401 Fast-Fail)
console.log('\n--- Probando executeWithRetry Fast-Fail en 401 Unauthorized ---');
let attempts401 = 0;
const mockFatalFn = async () => {
  attempts401++;
  const err = new Error('Unauthorized');
  err.status = 401;
  throw err;
};

let threwFastFail = false;
try {
  await executeWithRetry(mockFatalFn, {
    maxRetries: 3,
    providerName: 'Gemini',
    modelName: 'gemini-3.1-flash-lite'
  });
} catch (err) {
  threwFastFail = true;
  assert.strictEqual(err.status, 401);
}

assert(threwFastFail, 'Debió lanzar error inmediatamente');
assert.strictEqual(attempts401, 1, 'Error 401 no debe reintentarse (debe fallar en el intento 1)');
console.log('✅ executeWithRetry falló inmediatamente en 401 sin reintentos innecesarios.');

console.log('\n🎉 ¡TODOS LOS TESTS DE LA FASE 4 / E2E PASARON EXITOSAMENTE!');
