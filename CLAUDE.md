# CLAUDE.md

This is Xtreme Bookmarks — a local-first X/Twitter bookmark library, second-brain web app, and CLI.

## Commands

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run via tsx directly
npm run test         # Run tests
npm run start        # Run compiled dist/cli.js
```

## Architecture

TypeScript CLI and web app built around a local SQLite knowledge store. User data is stored under `~/.xtreme-bookmarks/` unless `XTREME_BOOKMARKS_DATA_DIR` is set.

### Key files

| File | Purpose |
|------|---------|
| `src/cli.ts` | Command definitions, progress bar, first-run UX |
| `src/web-server.ts` | Local web app server and API routes |
| `src/paths.ts` | Data directory resolution (`~/.xtreme-bookmarks/`) |
| `src/graphql-bookmarks.ts` | GraphQL sync engine (Chrome session cookies) |
| `src/bookmarks.ts` | OAuth API sync |
| `src/bookmarks-db.ts` | SQLite FTS5 index, search, list, stats |
| `src/bookmark-classify.ts` | Regex-based category classifier |
| `src/bookmark-classify-llm.ts` | Optional LLM classifier |
| `src/bookmarks-viz.ts` | ANSI terminal dashboard |
| `src/x-stream.ts` | X Feed watchlist, browser polling, save/remove behavior |
| `src/brain.ts` | Main Brain and Sub-Brain services |
| `src/chrome-cookies.ts` | Browser cookie extraction |
| `src/xauth.ts` | OAuth 2.0 flow |
| `src/db.ts` | WASM SQLite layer (sql.js-fts5) |

### Data flow

```
Browser session → X bookmark endpoints → JSONL cache → SQLite FTS5 index
                                    ↓
                           Regex classification
                                    ↓
                         Search / List / Viz
```

### Dependencies

All pure JavaScript/WASM — no native bindings:
- `commander` — CLI framework
- `sql.js` + `sql.js-fts5` — SQLite in WebAssembly
- `zod` — schema validation
- `dotenv` — .env file loading
