# CucumBrain 🧠

> **Agente RAG Personal y Orquestador de Conocimiento para Obsidian vía Telegram**

[Read in English](README.md) | [Leer en Español](README_ES.md)

CucumBrain es un asistente de IA auto-alojado y liviano diseñado para conectar **Bóvedas locales de Obsidian** con un **Bot privado de Telegram**. Indexa continuamente notas en Markdown dentro de una base de datos SQLite local, realiza Generación Aumentada por Recuperación (RAG) y dota al LLM de herramientas físicas para leer, crear, editar y conectar notas en tiempo real.

Diseñado para ejecutarse 24/7 en hardware con recursos limitados (ej. netbooks o Raspberry Pi con 2 GB de RAM) sin necesidad de bases de datos vectoriales pesadas.

---

## ✨ Características Principales

- **⚡ Sincronización de Bóveda en Tiempo Real**: Monitorea tu Bóveda de Obsidian usando `chokidar` e indexa al instante metadatos, etiquetas y WikiLinks (`[[Nota]]`) en un índice SQLite ultra rápido.
- **🛠️ Agente Activo con Tool Calling**: El LLM no es solo un lector, puede administrar físicamente tu base de conocimiento:
  - `createNote`: Crea nuevos archivos Markdown estructurados.
  - `readNote` / `deleteNote`: Lee notas no indexadas o elimina archivos físicamente.
  - `connectNotes`: Inyecta WikiLinks para interconectar notas en el grafo de Obsidian.
  - `updateNoteMetadata` / `replaceNoteSection`: Edita la cabecera YAML frontmatter o actualiza secciones específicas sin alterar el resto del documento.
- **🎙️ Mensajes de Voz Polimórficos**: Envía audios por Telegram; el bot los descarga, transcribe automáticamente (vía **Deepgram Nova-2**, **Gemini inlineData**, o **Whisper REST**) y procesa la consulta orgánicamente en el bucle del agente.
- **🧠 Memoria Conversacional de 3 Capas**:
  1. *Historial de Chat Reciente*: Contexto conversacional a corto plazo.
  2. *Resúmenes de Sesión*: Consolidación automática tras inactividad (>30 min) para evitar el desborde de tokens.
  3. *Memoria a Largo Plazo*: Preferencias y datos del usuario extraídos y persistidos automáticamente por el LLM.
- **🔀 Motor LLM Polimórfico**: Cambia de proveedor fácilmente entre **Google Gemini**, **OpenRouter** o **Groq** mediante variables de entorno.
- **🛡️ Seguridad e Identidad Estricta**: Middleware de Telegram que ignora usuarios no autorizados de forma silenciosa para evitar la exposición del bot.

---

## 🏗️ Arquitectura del Sistema

```text
┌─────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│ Usuario Telegram│ ────► │ Bot de Telegram  │ ────► │ Procesamiento   │
│ (Voz / Texto)   │ ◄──── │ (Telegraf + Auth)│ ◄──── │ de Audio/Texto  │
└─────────────────┘       └──────────────────┘       └────────┬────────┘
                                                              │
                                                              ▼
┌─────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│ Bóveda Obsidian │ ◄───► │ Vigilante        │ ◄───► │ Agente RAG +    │
│ (Markdown .md)  │       │ (Chokidar)       │       │ Indexador SQLite│
└─────────────────┘       └──────────────────┘       └─────────────────┘
```

---

## 🚀 Inicio Rápido

### Requisitos Previos
- **Node.js**: `v18.x` o superior
- **Obsidian**: Carpeta local con notas en Markdown (`vault/`)

### Instalación

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/tu-usuario/cucumbrain.git
   cd cucumbrain
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

3. **Configurar variables de entorno:**
   Copia `.env.example` a `.env` y completa tus credenciales:
   ```bash
   cp .env.example .env
   ```

   *Ejemplo de configuración `.env`:*
   ```env
   LLM_PROVIDER=gemini
   LLM_MODEL=gemini-3.5-flash
   GEMINI_API_KEY=tu_clave_api_gemini

   # Seguridad de Telegram
   TELEGRAM_BOT_TOKEN=tu_token_bot_telegram
   TELEGRAM_ALLOWED_USER_ID=tu_id_usuario_telegram

   # Transcripción de Audio Opcional
   TRANSCRIPTION_PROVIDER=deepgram
   TRANSCRIPTION_API_KEY=tu_clave_api_deepgram
   ```

4. **Inicializar base de datos y arrancar:**
   ```bash
   # Inicializar esquema SQLite
   npm run db:init

   # Iniciar Vigilante + Bot de Telegram
   npm start
   ```

---

## 📜 Scripts Disponibles

- `npm start`: Inicia el demonio del vigilante de archivos y el bot de Telegram.
- `npm run db:init`: Inicializa o resetea el esquema de la base de datos SQLite (`database.sqlite`).
- `npm run query`: Ejecuta una consulta de prueba por CLI contra el agente RAG.
- `npm run canvas:convert`: Convierte tableros `.canvas` de Obsidian en notas `.md` consolidadas.
- `npm run test:tools`: Ejecuta la verificación automatizada del llamado a herramientas del agente.

---

## 🛠️ Stack Tecnológico

- **Runtime**: Node.js ES Modules (`"type": "module"`)
- **Base de datos**: SQLite vía `better-sqlite3` (metadatos relacionales e indexación por palabras clave)
- **Pasarela Telegram**: `telegraf`
- **Vigilante de archivos**: `chokidar`
- **Parser Markdown**: `gray-matter`
- **Integraciones LLM**: `@google/generative-ai` (Gemini), OpenRouter, Groq API
- **Procesamiento de Audio**: Deepgram Nova-2, OpenAI/Groq Whisper REST API

---

## 📄 Licencia

Distribuido bajo la Licencia MIT. Consulta `LICENSE` para más información.
