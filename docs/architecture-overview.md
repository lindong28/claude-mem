# claude-mem Architecture Overview

## System Layers

```text
+-----------------------------------------------------------+
|  Claude Code (host)                                       |
|  +-- Hook System (5 events)                               |
|  +-- MCP Client (search tools)                            |
+-----------------------------------------------------------+
|  CLI Layer (Bun)                                          |
|  +-- bun-runner.js (Node->Bun bridge)                     |
|  +-- hook-command.ts (orchestrator)                        |
|  +-- handlers/ (context, session-init, observation,        |
|                 summarize, session-complete)               |
+-----------------------------------------------------------+
|  Worker Daemon (Express, per-user port 37700+(uid%100))   |
|  +-- SessionManager (session lifecycle)                   |
|  +-- SDKAgent (Claude Agent SDK)                          |
|  +-- SearchManager (search orchestration)                 |
|  +-- ProcessRegistry (subprocess management)              |
|  +-- ChromaSync (embedding synchronization)               |
+-----------------------------------------------------------+
|  Storage Layer                                            |
|  +-- SQLite (claude-mem.db) -- structured data            |
|  +-- ChromaDB (chroma.sqlite3) -- vector embeddings       |
|  +-- MCP Server (interface for Claude Code)               |
+-----------------------------------------------------------+
```

## Hook Lifecycle

| Event | Handler | What it does | Timeout |
|-------|---------|-------------|---------|
| Setup | version-check.js | Sub-100ms version-marker check; prompts `npx claude-mem repair` on mismatch | 60s |
| SessionStart | worker start + context | Start worker service and inject context | 60s |
| UserPromptSubmit | session-init | Register session + start SDK agent + semantic injection | 60s |
| PostToolUse | observation | Capture tool usage -> enqueue in worker | 120s |
| Summary | summarize | Request session summary from SDK agent | 120s |
| SessionEnd | session-complete | End session + drain pending messages | 30s |

On first install, `npx claude-mem install` sets up Bun and uv globally, runs `bun install` in the plugin cache, and writes an `.install-version` marker — all behind a visible clack spinner. The Setup hook then runs `version-check.js` on every Claude Code startup; if the plugin was upgraded externally (e.g. `claude plugin update`), it writes a hint to stderr asking the user to run `npx claude-mem repair`. The hook always exits 0 (non-blocking).

## Data Flow

```text
User prompt -> session-init -> /api/sessions/init + /api/context/semantic
  |
Tool use -> observation -> /api/sessions/observations
  |                              |
  |                    PendingMessageStore.enqueue()
  |                              |
  |                    SDKAgent.startSession()
  |                              |
  |                    Claude Agent SDK -> ResponseProcessor
  |                              |
  |                    +-- storeObservations() -> SQLite
  |                    +-- chromaSync.sync() -> ChromaDB
  |                    +-- broadcastObservation() -> SSE/UI
  |
Stop -> summarize -> /api/sessions/summarize
     -> session-complete -> /api/sessions/complete + drain
```

## Key Patterns

### Pending Queue (PendingMessageStore)

```text
enqueue()                -> INSERT row with `pending` status
claimNextMessage()       -> claim the oldest `pending` row with no failure code
successful response      -> store observations and delete only the claimed row IDs
failed response/exit     -> restore only the claimed row IDs to `pending` and record
                            `last_failure_code` plus `last_failure_at`
```

Parser is binary: `{ valid: true, observations, summary }` or `{ valid: false }`.
Observation storage and deletion of the covered queue rows share one transaction.
Failure-coded rows remain durable but are excluded from normal claims; unclaimed
rows in the same session remain eligible.

### Generator restart loop (SessionRoutes)

```text
Generator crash -> retry 1 (1s) -> retry 2 (2s) -> retry 3 (4s)
  -> consecutiveRestarts > 3 -> stop and let the iterator end
```

Counter resets to 0 when generator completes work naturally. A terminal
provider, parser, storage, or restart failure codes only the claimed batch;
newer eligible rows in the same session can still make forward progress.

### Graceful Degradation (hook-command.ts)

```text
Transport errors (ECONNREFUSED, timeout, 5xx) -> exit 0 (never block Claude Code)
Client bugs (4xx, TypeError, ReferenceError)  -> exit 2 (blocking, needs fix)
```

The worker being unavailable NEVER blocks the user's Claude Code session.

### Deduplication (observations)

```text
SHA256(memory_session_id + title + narrative)[:16] -> content_hash (16 hex chars)
If hash exists within 30s window -> return existing ID (no insert)
```

### Two Types of Session ID

- `contentSessionId` — from Claude Code, invariant during the session
- `memorySessionId` — from SDK Agent, changes on each worker restart

The conversion between them is handled by SessionStore and is critical for FK constraints.

## Storage

### SQLite (claude-mem.db)

| Table | Key fields | Purpose |
|-------|-----------|---------|
| sdk_sessions | content_session_id, memory_session_id, status | Session lifecycle |
| observations | memory_session_id, type, title, narrative, content_hash | Tool usage observations |
| session_summaries | memory_session_id, request, learned, completed | Session summaries |
| user_prompts | content_session_id, prompt_text | User prompt history |
| pending_messages | session_db_id, message_type | Per-session pending queue |
| observation_feedback | observation_id, signal_type | Usage tracking |

### ChromaDB (chroma.sqlite3)

Vector embeddings for semantic search. Each observation generates multiple documents:

```text
obs_{id}_narrative  -> main text
obs_{id}_fact_0     -> first fact
obs_{id}_fact_1     -> second fact
...
```

Accessed via chroma-mcp (MCP process), communication over stdio.

## Process Management

- **ProcessRegistry:** Tracks all Claude SDK subprocesses, manages PID lifecycle
- **Orphan Reaper (5min):** Kills processes with no active session
- **GracefulShutdown:** 7-step shutdown (PID file, children, HTTP server, sessions, MCP, DB, force-kill)
