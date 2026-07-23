# ADR 0002: Polymorphic Tool Calling and Vault Synchronization

## Context
In CucumBrain, we need the agent to perform actions on the Obsidian vault physically (such as creating notes, appending content, listing notes, and linking them via WikiLinks). The agent must run on different providers (Gemini SDK vs. OpenAI-compatible completions endpoints like OpenRouter and Groq) polymorphically.

Furthermore, we must avoid database schema alterations for chat logging (keeping tool calls/responses in-memory during a chat turn) and prevent race conditions when the agent runs sequential tool calls in the same chat session.

## Decision
We decided to:
1. **Implement Local Note Management Tools**: Create `src/agent/tools.js` implementing `createNote`, `appendNoteContent`, `connectNotes`, and `listNotes` using Node.js filesystem operations.
2. **Run Immediate Synchronous Indexing**: Tools write files to disk and immediately invoke `indexNote(filePath)` synchronously. This bypasses the 500ms stability threshold of the Chokidar watcher, ensuring the SQLite index is updated in real time for subsequent tool queries in the same agent turn.
3. **Define a Unified Lowercase Schema**: Declare schemas using lowercase parameter types (e.g., `string`, `integer`, `object`). Implement a helper `getToolsSchemaForProvider(provider)` to dynamically uppercase types for Gemini API compatibility.
4. **Implement an In-Memory Execution Loop**: Restructure `src/agent/agent.js` to execute up to 5 turns of tool requests. All intermediate messages (tool calls and results) are kept in-memory. Only the final user query and the final assistant textual response are persisted to the SQLite `chat_history` table.

## Status
Accepted

## Rationale
- **In-Memory History**: Respects the DB schema constraints while enabling standard multi-turn reasoning loops.
- **Sync Indexing**: Solves the race condition where the agent creates a note and immediately tries to query it or link it in the same turn before the background file watcher indexes it.
- **Polymorphism**: Avoids duplicating tool declarations for Gemini and OpenAI models.

## Consequences
- The agent is now an *active* participant that can physically organize and modify the Obsidian vault.
- Watcher triggers are still handled gracefully for external changes (like manual edits in Obsidian), while agent-made changes are synced instantly.
