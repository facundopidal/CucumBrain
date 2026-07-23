# CucumBrain 🧠

> **Personal RAG Agent & Knowledge Orchestrator for Obsidian via Telegram**

[Read in English](README.md) | [Leer en Español](README_ES.md)

CucumBrain is a lightweight, self-hosted AI assistant designed to bridge local **Obsidian Vaults** with a private **Telegram Bot**. It continuously indexes Markdown notes into a local SQLite database, performs Retrieval-Augmented Generation (RAG), and equips the LLM with physical tools to read, create, edit, and link notes in real time.

Designed to run 24/7 on resource-constrained hardware (e.g., netbooks or Raspberry Pi with 2GB RAM) using zero heavy vector databases.

---

## ✨ Features

- **⚡ Real-Time Vault Synchronization**: Monitors your Obsidian Vault using `chokidar` and instantly syncs metadata, tags, and WikiLinks (`[[Note]]`) into a lightweight SQLite index.
- **🛠️ Active Tool-Calling Agent**: The LLM isn't just a reader—it can actively manage your knowledge base:
  - `createNote`: Creates new structured Markdown files.
  - `readNote` / `deleteNote`: Reads un-indexed notes or cleans up files physically.
  - `connectNotes`: Injects WikiLinks to interconnect notes in your Obsidian graph.
  - `updateNoteMetadata` / `replaceNoteSection`: Edits frontmatter or updates specific section headers without touching the rest of the document.
- **🎙️ Polymorphic Voice Notes**: Sends voice messages via Telegram, automatically transcribes them (via **Deepgram Nova-2**, **Gemini inlineData**, or **Whisper REST**), and processes them organically through the agent loop.
- **🧠 3-Layer Conversational Memory**:
  1. *Recent Chat History*: Short-term conversational context.
  2. *Session Summaries*: Auto-consolidated when idle (>30 mins) to prevent token overflow.
  3. *Long-Term Memory*: Persisted user preferences and profile facts automatically extracted by the LLM.
- **🔀 Polymorphic LLM Engine**: Seamlessly switch providers between **Google Gemini**, **OpenRouter**, or **Groq** via environment variables.
- **🛡️ Strict Identity Security**: Telegram middleware rejects unauthorized users silently to prevent bot exposure.

---

## 🏗️ Architecture Overview

```text
┌─────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│ Telegram User   │ ────► │ Telegram Bot     │ ────► │  Audio / Text   │
│ (Voice / Text)  │ ◄──── │ (Telegraf + Auth)│ ◄──── │  Processing     │
└─────────────────┘       └──────────────────┘       └────────┬────────┘
                                                              │
                                                              ▼
┌─────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│ Obsidian Vault  │ ◄───► │ File Watcher     │ ◄───► │ RAG Agent +     │
│ (Markdown .md)  │       │ (Chokidar)       │       │ SQLite Indexer  │
└─────────────────┘       └──────────────────┘       └─────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: `v18.x` or higher
- **Obsidian**: Local folder with Markdown notes (`vault/`)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/cucumbrain.git
   cd cucumbrain
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

   *Sample `.env` configuration:*
   ```env
   LLM_PROVIDER=gemini
   LLM_MODEL=gemini-3.5-flash
   GEMINI_API_KEY=your_gemini_api_key

   # Telegram Security
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   TELEGRAM_ALLOWED_USER_ID=your_telegram_user_id

   # Optional Audio Transcription
   TRANSCRIPTION_PROVIDER=deepgram
   TRANSCRIPTION_API_KEY=your_deepgram_api_key
   ```

4. **Initialize database & start:**
   ```bash
   # Initialize SQLite schema
   npm run db:init

   # Start Watcher + Telegram Bot
   npm start
   ```

---

## 📜 Available Scripts

- `npm start`: Starts the real-time file watcher and Telegram bot daemon.
- `npm run db:init`: Initializes or resets the SQLite database schema (`database.sqlite`).
- `npm run query`: Runs a CLI test query against the RAG agent.
- `npm run canvas:convert`: Converts Obsidian `.canvas` boards into consolidated `.md` notes.
- `npm run test:tools`: Runs automated verification of agent tool executions.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js ES Modules (`"type": "module"`)
- **Database**: SQLite via `better-sqlite3` (relational metadata & keyword indexing)
- **Telegram Gateway**: `telegraf`
- **File Watching**: `chokidar`
- **Markdown Parser**: `gray-matter`
- **LLM Integrations**: `@google/generative-ai` (Gemini), OpenRouter, Groq API
- **Audio Processing**: Deepgram Nova-2, OpenAI/Groq Whisper REST API

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
