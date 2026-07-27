# Bitácora de Cambios - CucumBrain

## [2026-07-27] Despliegue en Producción y Gestión de Procesos PM2 (Fase 7 - Cierre de Roadmap)
- **Qué se hizo:** Se preparó la arquitectura completa de despliegue headless para la Samsung Netbook (Windows x86 / 32-bits). Se creó el archivo de configuración `ecosystem.config.cjs` para PM2 con límites de memoria ajustados a 300 MB, reinicio automático y logging estructurado. Se agregaron los comandos del ciclo de vida `npm run pm2:*` en `package.json` y se redactó una guía detallada paso a paso en `docs/DEPLOYMENT.md` para configurar el auto-arranque sin consola mediante `pm2-windows-startup`.
- **Decisiones clave y autoría:**
  - *Configuración Explícita de Modo Fork (`exec_mode: 'fork'`) (Consenso):* Se fijó el modo `fork` en `ecosystem.config.cjs` para evitar que PM2 intente iniciar la aplicación en modo `cluster`, el cual es incompatible con módulos nativos monolíticos como `better-sqlite3`.
  - *Persistencia de Carpeta de Logs en Git (Consenso):* Se añadió `logs/.gitkeep` para asegurar que la carpeta de logs exista por defecto tras clonar o actualizar en servidores Linux/Windows con permisos restrictivos, solucionando fallos de PM2 al intentar crear directorios.
  - *Gestión Headless con PM2 (Consenso):* Se eligió PM2 como gestor de procesos por su bajísimo consumo de recursos y capacidad de autoreinicio transparente ante cualquier falla de red o caídas.
  - *Límite Racional de Memoria (Consenso):* `max_memory_restart: '300M'` asegura que la aplicación nunca sature la memoria RAM limitada de la Netbook de 32 bits.
  - *Documentación de Despliegue Headless (Usuario):* Se redactó `docs/DEPLOYMENT.md` con las instrucciones exactas para que el servicio arranque 24/7 de forma totalmente transparente al encender el equipo.
- **Por qué (Justificación humana):** Concluye oficialmente el roadmap del proyecto CucumBrain, dejando una aplicación ligera, robusta y lista para ser ejecutada en producción desatendida.
- **Archivos afectados:**
  - [ecosystem.config.cjs](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/ecosystem.config.cjs)
  - [package.json](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/package.json)
  - [docs/DEPLOYMENT.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/docs/DEPLOYMENT.md)
  - [docs/bitacora.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/docs/bitacora.md)

## [2026-07-27] Conectividad Semántica y Grafo Relacional (Fase 6 - Fast-Track)
- **Qué se hizo:** Se integró el modelo mental de taxonomía de vida del usuario dentro de las instrucciones del sistema (`systemInstruction` en `src/agent/agent.js`), estructurando las relaciones entre Proyectos Activos, Consultora Freelance, Ideas SaaS, Economía/Finanzas y Bloqueos de Tiempo. Se obligó al agente a realizar un enlazado proactivo automático ejecutando `connectNotes` (`[[WikiLinks]]`) y a verificar la existencia de ideas previas en incubación/pausa antes de clasificar pensamientos como nuevas ideas.
- **Decisiones clave y autoría:**
  - *Taxonomía Estructurada de Dominios (Usuario):* Se explicitó en la instrucción del sistema el mapa conceptual que conecta desarrollos activos (GymChart, Cerebro, Shim) con la línea comercial de la Consultora y las metas financieras/tiempo.
  - *Enlazado Proactivo Obligatorio (Consenso):* Se fijó la regla 9 para que el bot llame de manera autónoma a `connectNotes` al crear o actualizar notas, tejiendo la red de enlaces relacionales de Obsidian automáticamente.
  - *Control de Duplicados e Histórico (Consenso):* Se instruyó la búsqueda previa de notas históricas pausadas o en incubación antes de registrar duplicados.
- **Por qué (Justificación humana):** Eleva la inteligencia relacional de Cerebro para que actúe como un verdadero asistente contextual que vincula proyectos con sus razones de negocio y limitaciones de tiempo sin intervención manual.
- **Archivos afectados:**
  - [src/agent/agent.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/agent/agent.js)
  - [docs/bitacora.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/docs/bitacora.md)

## [2026-07-24] Formateo Visual de Mensajes y Parser Markdown-a-HTML en Telegram (Fast-Track)
- **Qué se hizo:** Se implementó una función conversora `markdownToTelegramHtml` en `src/bot/bot.js` que transforma la sintaxis de Markdown generada por el LLM o leída de las notas (`**negrita**`, `` `código` ``, `# encabezados`, `[[WikiLinks]]`) a etiquetas HTML nativas de Telegram (`<b>`, `<code>`, `<pre>`), y se le agregó un mecanismo de captura de excepciones que realiza un fallback automático a texto plano si Telegram rechaza el formato.
- **Decisiones clave y autoría:**
  - *Ubicación a Nivel de Módulo de Funciones Exportadas (Consenso):* Se movió `markdownToTelegramHtml` fuera del bloque condicional `else` hacia el nivel superior de `src/bot/bot.js` para cumplir con las reglas de ES Modules de Node.js y corregir el `SyntaxError: Unexpected token 'export'`.
  - *Adopción de HTML con Fallback Automático (Usuario):* Se prefirió `parse_mode: 'HTML'` por sobre `MarkdownV2` debido a la extrema fragilidad de este último ante caracteres como `-`, `_`, `[`, `]`. El fallback a texto plano garantiza que el bot nunca falle ni se caiga.
  - *Resaltado Visual de WikiLinks (Consenso):* Los enlaces a notas tipo `[[Mi Nota]]` se formatean automáticamente como `<b>[[ Mi Nota ]]</b>` para destacar visualmente las conexiones relacionales en la interfaz del chat.
- **Por qué (Justificación humana):** Mejora significativamente la experiencia visual del usuario en Telegram al leer respuestas del bot, eliminando la sintaxis cruda y manteniendo una presentación elegante y legible.
- **Archivos afectados:**
  - [src/bot/bot.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/bot/bot.js)
  - [docs/bitacora.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/docs/bitacora.md)

## [2026-07-22] Preparación de Repositorio Público y Sanitización de Privacidad (Fast-Track)
- **Qué se hizo:** Se sanitizó el repositorio local para su publicación pública en GitHub. Se añadieron las carpetas `vault/` y `temp/` a `.gitignore`, se desvinculó la Bóveda del control de versiones sin afectar los archivos locales, se creó un `README.md` exhaustivo y profesional en inglés junto a su versión completa en español (`README_ES.md`) con un selector de idiomas, y se re-inicializó el historial local de Git en un commit inicial impecable (`feat: initial commit of CucumBrain RAG Agent`).
- **Decisiones clave y autoría:**
  - *Sanitización Completa de Historial de Git (Usuario):* Al no haber sido subido aún a GitHub, se reinició la rama de Git a una versión limpia raíz para garantizar que ninguna nota personal commiteada en el pasado o clave de API permanezca expuesta en commits anteriores.
  - *Preservación de Notas Locales (Consenso):* `git rm -r --cached vault` desvincula el rastreo de Git manteniendo todos los archivos de notas de Obsidian 100% intactos en el disco rígido local.
  - *Documentación Bilingüe de Presentación (Usuario):* Se redactaron tanto `README.md` (inglés) como `README_ES.md` (español) documentando la arquitectura del proyecto, diagramas de flujo, características de RAG/Tool Calling, guía de instalación y comandos principales.
- **Por qué (Justificación humana):** Prepara el proyecto para ser compartido públicamente con startups y reclutadores tanto locales como internacionales, facilitando la lectura en ambos idiomas y protegiendo al 100% la privacidad del usuario.
- **Archivos afectados:**
  - [.gitignore](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/.gitignore)
  - [README.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/README.md)
  - [README_ES.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/README_ES.md)
  - [docs/bitacora.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/docs/bitacora.md)


## [2026-07-20] Consultas Estructuradas y Edición de Metadatos (Fase 5 - Fast-Track)
- **Qué se hizo:** Se dotó al agente de herramientas para consultar SQLite por metadatos (`queryNotesByMetadata`), modificar el YAML frontmatter sin alterar el texto (`updateNoteMetadata`), reemplazar secciones Markdown completas (`replaceNoteSection`), leer notas completas por título (`readNote`) y eliminar notas físicamente (`deleteNote`). En el bot, se implementó `replyLongMessage` para dividir respuestas mayores a 4000 caracteres. También se incrementó el límite de turnos secuenciales a 8 y se mejoró el manejador de límite alcanzado.
- **Decisiones clave y autoría:**
  - *Búsquedas Insensibles a Mayúsculas/Minúsculas en Herramientas (Consenso):* Se actualizaron las consultas SQL de `readNote`, `deleteNote`, `updateNoteMetadata` y `replaceNoteSection` con `LOWER()` en `tools.js` para asegurar coincidencias sin importar si se busca con o sin mayúsculas.
  - *Preservación de Candidate Parts en Gemini (Consenso):* Se modificó `agent.js` para inyectar directamente el objeto `response.candidates[0].content` devuelto por Gemini en el historial de contenidos del bucle de herramientas, preservando las firmas de pensamiento (`thought_signature`) de modelos de razonamiento (3.x) y fijando `gemini-1.5-flash` como modelo estable.
  - *Corrección de Modelo Gemini (Consenso):* Se cambió el modelo por defecto a `gemini-1.5-flash` en `agent.js` para evitar nombres de modelos obsoletos (404 en 2.5-flash).
  - *Incremento de límite de herramientas (Consenso):* Se subió `maxTurns` de 5 a 8 para dar espacio suficiente a operaciones secuenciales de refactorización (ej. listar, leer, crear y borrar).
  - *Manejador de límite alcanzado (Consenso):* Si el agente agota los 8 turnos de herramientas, se le inyecta una instrucción restrictiva que bloquea la alucinación de tool calls en texto (como `<tool_call>`) y le exige generar un resumen amigable en español detallando qué cambios completó y qué quedó pendiente.
  - *Regla de Idioma y Síntesis (Usuario):* Se agregó la regla 9 al `systemInstruction` para prohibir respuestas en inglés o fugas de monólogos internos de planificación, garantizando respuestas directas y breves en español.
  - *Prevención de Mensaje Vacío en Telegram y Consolidación (Consenso):* Se agregaron verificaciones de fallback en `agent.js` (`askAgent` y `consolidateSession`) y en `replyLongMessage` de `bot.js` para asegurar que nunca se inserten resúmenes vacíos en SQLite ni se envíen cadenas nulas a Telegram si un LLM devuelve resultados vacíos.
  - *Prevención de Error Telegram 400 (Consenso):* `replyLongMessage` fragmenta respuestas extensas del LLM en bloques de ~4000 caracteres respetando los saltos de línea, solucionando el error `400 Bad Request: message is too long`.
  - *Herramientas de Lectura Directa y Borrado (Consenso):* Se añadieron `readNote` (para permitir a la IA leer notas específicas que no entraron en el RAG) y `deleteNote` (para desvincular y borrar archivos físicos y registros de SQLite al solicitar limpiezas).
  - *Prohibición de Notas Índice Físicas (Usuario):* Se instruyó explícitamente a la IA en `systemInstruction` para que no cree archivos físicamente para listas o resúmenes (ej: "Proyectos Activos"), respondiendo estas dudas en texto tras consultar los metadatos en SQLite.
  - *Edición limpia de Secciones con gray-matter (Consenso):* `replaceNoteSection` localiza los límites de un encabezado Markdown con expresiones regulares y reemplaza únicamente ese bloque, evitando la duplicación de encabezados al final de los archivos.
  - *Actualización aislada de Frontmatter (Consenso):* `updateNoteMetadata` modifica el objeto YAML con `gray-matter` y regenera la cabecera re-indexando inmediatamente en SQLite.
- **Por qué (Justificación humana):** Resuelve los cuellos de botella de mensajería larga en Telegram, le permite a la IA realizar operaciones de lectura exacta y borrado físico cuando el usuario lo solicita, evita la contaminación de la Bóveda con notas de índice redundantes, y estabiliza las respuestas de la IA cuando agota sus turnos en procesos complejos.
- **Archivos afectados:**
  - [src/agent/tools.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/agent/tools.js)
  - [src/agent/agent.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/agent/agent.js)
  - [src/bot/bot.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/bot/bot.js)

## [2026-07-17] Captura de Medios y Notas de Voz (Fase 4 - Fast-Track)
- **Qué se hizo:** Se habilitó al bot de Telegram para capturar mensajes de voz, descargarlos localmente de manera segura en un directorio temporal y transcribirlos de forma polimórfica (Gemini nativo inlineData o APIs de Whisper). La transcripción se inyecta en el loop de `askAgent` para responder o ejecutar herramientas.
- **Decisiones clave y autoría:**
  - *Desacoplamiento del proveedor de transcripción (Usuario):* Se añadieron variables `TRANSCRIPTION_PROVIDER` y `TRANSCRIPTION_API_KEY` para separar de forma independiente el motor de transcripción del motor conversacional RAG, permitiendo usar servicios especializados de audio sin cambiar el LLM principal.
  - *Soporte nativo para Deepgram Nova-2 (Consenso):* Se implementó el soporte para la API de Deepgram enviando el buffer binario directo del audio `.ogg` con tipo `audio/ogg`, habilitando transcripciones ultrarrápidas y precisas en español mediante su modelo insignia `nova-2` con créditos gratuitos.
  - *Uso de Gemini inlineData (Consenso):* Para evitar el costo y la latencia de subir archivos mediante la API de Files de Gemini, se codificó el buffer de audio en Base64 e inyectó inline como `audio/ogg` directamente en la consulta.
  - *Enrutamiento implícito vía askAgent (Usuario):* En lugar de programar una lógica rígida de "crear nota a partir de voz", la transcripción se alimenta directamente al agente RAG con herramientas. Esto permite que el audio sirva tanto para hacer consultas libres (sin crear notas) como para invocar herramientas físicas de forma orgánica.
  - *Descarga robusta con streams (Consenso):* Para evitar el error de red `fetch failed` propio de la librería interna Undici de Node 18 al resolver IPs en Windows, se reemplazó la descarga por `fetch` con un flujo de streams nativo de `https.get` que escribe directamente el archivo de Telegram a disco.
- **Por qué (Justificación humana):** Optimiza el tiempo y reduce la fricción del usuario al permitir capturar ideas rápidas o hacer consultas complejas por voz mientras camina, sin obligar al Cerebro a crear notas de manera inflexible, resolviendo limitaciones de cuotas de APIs de IA y bloqueos de red en Windows.
- **Archivos afectados:**
  - [src/bot/bot.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/bot/bot.js)
  - [src/utils/audio.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/utils/audio.js)
  - [src/utils/transcriber.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/utils/transcriber.js)
  - [.env.example](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/.env.example)

## [2026-07-17] Agente Activo y Ejecución de Herramientas (Fase 3)
- **Qué se hizo:** Se transformó el agente pasivo de RAG en un agente activo dotado de herramientas para interactuar físicamente con la Bóveda de Obsidian. Se implementaron funciones para crear notas, agregar contenido, conectar notas con WikiLinks y listar notas.
- **Decisiones clave y autoría:**
  - *Indexación síncrona inmediata (Consenso):* Las herramientas físicas llaman a `indexNote` inmediatamente tras escribir a disco. Esto evita el retardo de 500ms del vigilante y permite que la IA consulte o conecte notas recién creadas en el mismo turno.
  - *Mapeo dinámico polimórfico de esquemas (Consenso):* Se implementó un adaptador para usar una sola declaración de esquemas en minúsculas y traducirla dinámicamente a mayúsculas para Gemini SDK o mantenerla para OpenRouter/Groq.
  - *Ciclo de ejecución en memoria (Consenso):* Los turnos intermedios del agente (tool calls y resultados) se gestionan en memoria para evitar alterar el esquema de base de datos de historial de chat, registrando en SQLite únicamente el resultado final de texto.
  - *ADR Generado:* Se documentaron estas decisiones detalladamente en [docs/adr/0002-polymorphic-tool-calling.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/docs/adr/0002-polymorphic-tool-calling.md).
- **Por qué (Justificación humana):** Convierte al bot de Telegram de un mero lector de notas en un co-administrador de conocimiento capaz de estructurar, independizar y conectar ideas al instante mientras chatea con el usuario.
- **Archivos afectados:**
  - [src/agent/tools.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/agent/tools.js)
  - [src/agent/agent.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/agent/agent.js)
  - [package.json](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/package.json)
  - [docs/adr/0002-polymorphic-tool-calling.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/docs/adr/0002-polymorphic-tool-calling.md)

## [2026-07-17] Conversor de Tableros Canvas a Markdown (Fase 2 - Utilidad)
- **Qué se hizo:** Se creó una herramienta de conversión por lotes para traducir archivos `.canvas` a `.md` respetando la ubicación espacial de las tarjetas e identificando tipos de contenido (dudas, tareas, principios) y colores de borde.
- **Decisiones clave y autoría:**
  - *Mapeo semántico de relaciones (Consenso):* El script traduce las IDs de relaciones visuales de Canvas a descripciones de lenguaje humano antes de enviarlas al LLM, garantizando que el modelo comprenda las dependencias lógicas complejas de las notas.
  - *Detección espacial de grupos por coordenadas (Consenso):* Se calcula si un nodo está contenido dentro de la caja delimitadora de un grupo para clasificarlo de forma matemática en su categoría correcta (ej: evitar agrupar psmux erróneamente en MultiCRM).
  - *Filosofía de Graduación de Ideas (Usuario):* El sistema opera bajo un modelo nativo Zettelkasten de notas individuales para albergar reflexiones desarrolladas (sea de tecnología, literatura u otros temas). La centralización en una "nota núcleo" se reserva estrictamente para ideas pasajeras de baja madurez para evitar el rozamiento inicial, independizándolas al madurar.
  - *Límites cognitivos de decisión (Usuario):* El bot debe limitar a un máximo de 4 las alternativas presentadas a la vez para no saturar al usuario, y debe rastrear ideas descartadas para explicar por qué se desestimaron.
- **Por qué (Justificación humana):** Resuelve el problema del desorden y pérdida de rumbo en Canvas grandes al unificarlos en notas consolidadas estructuradas que alimentan adecuadamente el RAG, facilitando la toma de decisiones al recordar descartes pasados.
- **Archivos afectados:**
  - [src/utils/canvas-converter.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/utils/canvas-converter.js)
  - [src/agent/agent.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/agent/agent.js)
  - [package.json](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/package.json)
  - [docs/KNOWLEDGE.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/docs/KNOWLEDGE.md)

## [2026-07-17] Implementación de Memoria Conversacional de 3 Capas (Fase 2)
- **Qué se hizo:** Se integró un sistema de memoria en tres niveles: historial de chat reciente (`chat_history`), resúmenes consolidados de sesiones (`session_summaries`), y variables persistentes a largo plazo (`long_term_memory`).
- **Decisiones clave y autoría:**
  - *Trigger de consolidación por inactividad (Consenso):* Si pasan más de 30 minutos desde el último mensaje, al recibir un nuevo mensaje se dispara automáticamente la consolidación de la sesión anterior.
  - *Extracción y persistencia de hechos en JSON (Consenso):* La IA analiza la conversación anterior para extraer datos clave del usuario en un formato JSON estructurado que actualiza la base de datos de largo plazo de manera orgánica.
  - *Inyección automática de datos a largo plazo (Consenso):* Se inyecta la tabla completa de memoria a largo plazo en las instrucciones de sistema en cada llamada para dar al agente un contexto constante de las preferencias y perfil del usuario.
  - *Limpieza del historial reciente (Consenso):* Al consolidar, se borra el chat reciente para evitar saturar la ventana de contexto y tokens.
- **Por qué (Justificación humana):** Evita la "amnesia" del bot a corto plazo en conversaciones activas, a la vez que previene el desborde de tokens en prompts largos consolidando las charlas anteriores en resúmenes legibles y datos clave permanentes de forma automática y transparente.
- **Archivos afectados:**
  - [src/database/init.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/database/init.js)
  - [src/agent/agent.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/agent/agent.js)
  - [package.json](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/package.json)

## [2026-07-16] Inicialización del Proyecto y MVP Funcional (Fase 1)
- **Qué se hizo:** Se creó la estructura inicial del proyecto, el esquema de base de datos relacional para el índice, el vigilante de archivos locales para sincronización automática, el agente de inferencia polimórfico con recorte de contexto y la pasarela del bot de mensajería privada.
- **Decisiones clave y autoría:**
  - *Alineación de versión de Node.js a v18.20.4 (Consenso):* Para emparejar el entorno local de desarrollo de Windows con la versión activa en la netbook de producción, facilitando la instalación de precompilados de módulos nativos.
  - *Uso de SQLite con Driver síncrono better-sqlite3 (Consenso):* Seleccionado para actuar como el índice relacional rápido de las notas, evitando bloqueos de asincronía innecesarios en la indexación de archivos.
  - *Búsqueda de contexto basada en palabras clave (Consenso):* En lugar de usar bases de datos vectoriales y embeddings locales (inviables en el hardware limitado de la netbook con 2GB RAM), se implementó búsqueda por palabras clave en la base de datos relacional filtrando términos de parada (stop-words).
  - *Exclusión de dibujos de Excalidraw (Consenso):* Se ignoran archivos `.excalidraw.md` en el vigilante e indexador, ya que contienen descripciones de gráficos visuales en JSON de gran tamaño (más de 1MB) que no aportan contexto textual útil y agotan los límites de tokens del proveedor de IA.
  - *Límite de tamaño de contexto (Consenso):* Se limitó cada nota individual a 4,000 caracteres y el total de contexto acumulado a 16,000 caracteres para asegurar que las consultas quepan en el límite de 8,000 tokens de los modelos gratuitos de los proveedores externos.
  - *Filtro de seguridad en canal de mensajería (Consenso):* Implementado un filtro de identidad estricto para ignorar de forma silenciosa mensajes de IDs distintos al del propietario.
- **Por qué (Justificación humana):** Necesitamos un agente liviano y auto-alojado que pueda correr 24/7 en una Netbook física limitada sin cuellos de botella de hardware, y que a la vez sea accesible de forma segura y gratuita desde el celular.
- **Archivos afectados:**
  - [package.json](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/package.json)
  - [src/database/db.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/database/db.js)
  - [src/database/init.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/database/init.js)
  - [src/database/indexer.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/database/indexer.js)
  - [src/watcher/watcher.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/watcher/watcher.js)
  - [src/agent/agent.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/agent/agent.js)
  - [src/bot/bot.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/bot/bot.js)
  - [src/index.js](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/src/index.js)
  - [.gitignore](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/.gitignore)
  - [.env.example](file:///C:/Users/Win10/Desktop/Programacion/Dev/CucumBrain/.env.example)

## Planificación de Próximas Fases (Roadmap de Desarrollo)

### Fase 3: Agente Activo (Tool Calling / Ejecución de Herramientas)
- **Objetivo:** Permitir que el agente no solo converse, sino que modifique y gestione la bóveda de Obsidian desde Telegram.
- **Herramientas a implementar en el agente:**
  - `crear_nota(titulo, contenido, tipo_id, importancia)`: Escribe físicamente archivos `.md` en las carpetas correspondientes de la Bóveda.
  - `modificar_nota(ruta_archivo, contenido_a_anexar)`: Modifica contenidos y checklists (estados `[ ]`, `[?]`, `[-]`) de notas existentes.
  - `conectar_notas(ruta_origen, ruta_destino)`: Edita la nota de origen para inyectar un WikiLink al destino, forzando la creación de relaciones en el grafo.
  - `listar_notas()`: Permite al agente validar nombres de archivos físicos existentes en disco antes de sugerir creaciones redundantes.
- **Flujo:** La modificación física en disco disparará el *Watcher* automáticamente, manteniendo SQLite sincronizado de forma transparente.

### Fase 4: Captura de Medios (Notas de Voz)
- **Objetivo:** Habilitar el bot de Telegram para recibir mensajes de audio, transcribirlos con Whisper / APIs de Gemini, y generar automáticamente notas estructuradas en la Bóveda basadas en la transcripción.

