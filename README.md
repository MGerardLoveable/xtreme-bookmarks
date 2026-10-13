# Xtreme Bookmarks

Sync and store your X/Twitter bookmarks locally, browse them in the Xtreme Bookmarks web app, search them, organize them into a second brain, and use agents to keep knowledge spaces fresh.

Local-first by default: your bookmark database, media cache, generated markdown, and credentials stay on your machine unless you choose to deploy them.

## Why this exists

X bookmarks are where many builders, researchers, and maintainers collect fast-moving technical knowledge, but the native product makes that knowledge hard to search, preserve, cite, and turn into durable project memory. Xtreme Bookmarks turns a personal bookmark archive into a local, searchable knowledge base with CLI workflows, a web UI, wiki export, and agent-friendly context.

## Install

Requires Node.js 20+. Chrome, Brave, or Firefox can be used for browser-session bookmark sync; OAuth/API credentials are optional for features that need official X API access.

```bash
npm install --global xtreme-bookmarks
xb --help
```

## Quick start

### Run the latest GitHub version on another computer

Install Node.js 20+ and Git, then run:

```bash
git clone https://github.com/MGerardLoveable/xtreme-bookmarks.git
cd xtreme-bookmarks
npm ci
npm run build
node bin/xb.mjs web
```

Open `http://127.0.0.1:3848/`. This runs the committed GitHub version;
the npm-published package may be older.

GitHub contains the application, not your private archive or credentials.
To preserve bookmarks, notes, workspaces, and history, stop the app and any
background sync on the original computer, then securely back up its complete
data directory (`node bin/xb.mjs path` shows the configured location).
Restore that backup to a private directory on the new computer and set
`XTREME_BOOKMARKS_DATA_DIR` to that directory before starting the app.
Keep the original backup until you have verified the restored library and notes.
Do not merge two independently modified data directories or run both computers
against a shared live database.

The data directory can include session cookies and OAuth tokens: never commit it
to Git or share it publicly. Sign into X in a supported browser on the new machine
and reconnect authentication as needed. Reconfigure any model/provider credentials
locally; Git does not transfer `.env` files or machine-specific service settings.
Without a backup, you can sync again, but that will not recover personal notes or
workspace history. On macOS, install the optional service only after confirming
the restored data directory using the service instructions below.

### CLI quick start

```bash
# 1. Sync your bookmarks
xb sync

# 2. Search them
xb search "distributed systems"

# 3. Open the web app
xb web
```

On first run, `xb sync` uses your chosen browser session and downloads bookmarks into `~/.xtreme-bookmarks/`.

## The research desk

The web app is organized around using saved information, not merely storing it:

- **Home** brings together recall, active workspaces, and items needing attention. Recall sessions record your response and schedule the next review; Latest saves opens the archive in saved order.
- **Archive** searches the actual post text, quoted posts, authors, personal notes, categories, collections, and domains with BM25 ranking and visible match reasons.
- **Activation** lets you record why you saved something, its intent, importance, status, and next review date.
- **Brain Cycle** distills source text into a summary, key claim, why it matters, a suggested next action, entities, freshness, and conservative contradiction candidates. Today items and opened items can be distilled on demand, while incremental background passes catch up the archive.
- **Workspaces** turn bookmarks into project evidence, decisions, tasks, inspiration, or references. Projects, open questions, dossiers, and durable topics can each carry a focus question.
- **Ask** can search the entire archive or one workspace, keeps a bounded conversation, and shows canonical evidence behind the answer.
- **Make** turns an answer and its evidence into reusable outputs. Action plans and experiments use the connected model to create executable steps, prerequisites, and completion criteria, then persist progress and observed results.
- **Author dossiers** show a person's saved history, recurring territory, claims, timeline, notes, and explicit workspace contributions.
- **Radar** watches selected X accounts and exposes Brain Cycle coverage, stale claims, and possible tensions alongside incoming signals.

Personal annotations, original source text, and generated synthesis remain separate in context packs so an agent or collaborator can tell where every statement came from.

### Research workbench

Open **Topics > Research** for the unified research workflow:

- **Search** combines exact text with local semantic recall and cross-encoder reranking. Posts, quoted text, image descriptions, personal notes, highlights, extracted content, and experiment outcomes remain separately attributed. Workspace, content-type, date, and chronological filters constrain retrieval.
- **Briefs** keep versioned workspace recommendations, alternatives, uncertainty, changes, and next steps alongside their evidence. Source edits, exclusions, reviewed claims, and experiment results invalidate cached briefs.
- **Plans** store dependent steps, success criteria, progress, and observed outcomes. Recorded results become searchable personal experience.
- **Connections** propose bounded tests connecting techniques across workspaces. Dismissed or already-tried suggestions are suppressed.
- **Evidence** tracks exact source passages, conditions, and unverified/supported/disputed/superseded/withdrawn status with revision history.
- **Imports** records new versus scanned/existing items, pages, stopping reasons, and extraction errors. Recent-source extraction jobs are resumable and retryable.
- **Agents** creates revocable MCP bearer tokens restricted to selected workspaces. Read-only is the default; optional write access permits proposals and experiment results, not arbitrary archive administration.

GitHub gap research returns candidate repositories for review and can add an accepted repository to a workspace. X research opens a query link; it does not silently import or independently verify external posts.

### Local extraction and performance

For the file-backed database on Node.js 22.16+ (Node.js 24 recommended), set `XB_DB_DRIVER=native`. SQLite WAL persists individual page writes; backups use a consistent SQLite snapshot. Node.js 20 retains the existing WASM database path. The adapter requires the [Node.js array-returning SQLite statements](https://nodejs.org/docs/latest-v22.x/api/sqlite.html#statementsetreturnarraysenabled).

The first server launch builds a unified full-text index. Local CPU models are downloaded from Hugging Face and cached under `data/models`; no embedding API key is needed. Semantic indexing catches up incrementally, prioritizing workspace and recent material. Exact text search remains available while indexing runs. Set `XB_SEMANTIC_SEARCH=0` to disable background embeddings; the Library's Text mode bypasses semantic retrieval.

Optional `tesseract`, `ffmpeg`, and `pdftotext` executables enable OCR, transcription, and PDF extraction. Articles use Readability. Video processing is currently limited to direct video files up to 32 MB and the first two minutes; the source inspector displays this coverage. Thread extraction includes saved conversation posts only, not unsaved replies. Unsupported, blocked, and oversized sources are shown as failed/retryable jobs rather than described as fully indexed.

Detailed recommendations use the configured synthesis provider. To reconnect an existing Grok subscription on a headless server, run `grok login --device-auth` as the application service user. Without a connected provider, briefs display an evidence overview and plans use a clearly labelled guided pilot. Research synthesis cannot execute tools or delegate work.

The MCP endpoint is `POST /mcp` (JSON-RPC, protocol `2025-03-26`). Owner Basic authentication or an Agent bearer token is required. Tools: `search`, `fetch_source`, `workspace_brief`, `propose_update`, and `record_experiment`. Reverse proxies must forward bearer authorization on this path to the app while preserving normal owner authentication on every other path.

Verification: `npm run build`, `node --import tsx --test tests/*.test.ts`, and `node scripts/verify-research.mjs --semantic --browser` (requires Playwright with Chrome, or `XB_PLAYWRIGHT_MODULE` pointing to an installed Playwright module). The last command uses synthetic private fixtures, checks recall, task persistence, scoped agent denial/revocation, and desktop/tablet/mobile layouts. Set `XB_RESEARCH_SYNTHESIS=0` for offline guided-plan verification.

## Commands

### Sync

| Command | Description |
|---------|-------------|
| `xb sync` | Download and sync bookmarks (no API required) |
| `xb sync --rebuild` | Full history crawl (not just incremental) |
| `xb sync --gaps` | Backfill missing quoted tweets and expand truncated articles |
| `xb sync --classify` | Sync then classify new bookmarks with LLM |
| `xb sync --api` | Sync via OAuth API |
| `xb auth` | Set up OAuth for API sync and X bookmark delete/write actions |

### Search and browse

| Command | Description |
|---------|-------------|
| `xb search <query>` | Full-text search with BM25 ranking |
| `xb list` | Filter by author, date, category, domain |
| `xb show <id>` | Show one bookmark in detail |
| `xb sample <category>` | Random sample from a category |
| `xb stats` | Top authors, languages, date range |
| `xb viz` | Terminal dashboard with sparklines, categories, and domains |
| `xb categories` | Show category distribution |
| `xb domains` | Subject domain distribution |

### Classification

| Command | Description |
|---------|-------------|
| `xb classify` | Classify by category and domain using LLM |
| `xb classify --regex` | Classify by category using simple regex |
| `xb classify-domains` | Classify by subject domain only (LLM) |
| `xb model` | View or change the default LLM engine |

### Knowledge base

| Command | Description |
|---------|-------------|
| `xb md` | Export bookmarks as individual markdown files |
| `xb wiki` | Compile an interlinked knowledge base |
| `xb ask <question>` | Ask questions against the knowledge base |
| `xb ask <question> --save` | Ask and save the answer as a concept page |
| `xb lint` | Health-check the wiki for broken links and missing pages |
| `xb lint --fix` | Auto-fix fixable wiki issues |

### Agent integration

| Command | Description |
|---------|-------------|
| `xb skill install` | Install `/fieldtheory` skill for Claude Code and Codex |
| `xb skill show` | Print skill content to stdout |
| `xb skill uninstall` | Remove installed skill files |

### Utilities

| Command | Description |
|---------|-------------|
| `xb index` | Rebuild search index from JSONL cache (preserves classifications) |
| `xb fetch-media` | Download media assets (static images only) |
| `xb status` | Show sync status and data location |
| `xb path` | Print data directory path |

## Agent integration

Install the `/fieldtheory` skill so your agent automatically searches your bookmarks when relevant:

```bash
xb skill install     # Auto-detects Claude Code and Codex
```

Then ask your agent:

> "What have I bookmarked about cancer research in the last three years and how has it progressed?"

> "I bookmarked a number of new open source AI memory tools. Pick the best one and figure out how to incorporate it in this repo."

> "Every day please sync any new X bookmarks using the Field Theory CLI."

Works with Claude Code, Codex, or any agent with shell access.

## Scheduling

```bash
# Sync every morning at 7am
0 7 * * * xb sync

# Sync and classify every morning
0 7 * * * xb sync --classify
```

## Data

All data is stored locally at `~/.xtreme-bookmarks/`:

```
~/.xtreme-bookmarks/
  bookmarks.jsonl         # raw bookmark cache (one per line)
  bookmarks.db            # SQLite FTS5 search index
  bookmarks-meta.json     # sync metadata
  oauth-token.json        # OAuth token (if using API mode, chmod 600)
  md/                     # markdown knowledge base (xb wiki / xb md)
```

Override the location with `XTREME_BOOKMARKS_DATA_DIR`:

```bash
export XTREME_BOOKMARKS_DATA_DIR=/path/to/custom/dir
```

### Keep the web app running on macOS

Install Xtreme Bookmarks as a user service so it starts at login and restarts
automatically if the server exits:

```bash
XTREME_BOOKMARKS_DATA_DIR=/path/to/custom/dir npm run service:install:mac
```

The service listens on `http://127.0.0.1:3848/` and writes logs to
`~/Library/Logs/XtremeBookmarks/`.

To remove all data: `rm -rf ~/.xtreme-bookmarks`

## Categories

| Category | What it catches |
|----------|----------------|
| **tool** | GitHub repos, CLI tools, npm packages, open-source projects |
| **security** | CVEs, vulnerabilities, exploits, supply chain |
| **technique** | Tutorials, demos, code patterns, "how I built X" |
| **launch** | Product launches, announcements, "just shipped" |
| **research** | ArXiv papers, studies, academic findings |
| **opinion** | Takes, analysis, commentary, threads |
| **commerce** | Products, shopping, physical goods |

Use `xb classify` for LLM-powered classification that catches what regex misses.

## Platform support

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Session sync (`xb sync`) | Chrome, Brave, Arc, Firefox | Firefox | Firefox |
| OAuth API sync (`xb sync --api`) | Yes | Yes | Yes |
| Search, list, classify, viz, wiki | Yes | Yes | Yes |

Session sync extracts cookies from your browser's local database. Use `xb sync --browser <name>` to pick a browser. On platforms where session sync isn't available, use `xb auth` + `xb sync --api`.

## Security

**Your archive stays local by default.** Xtreme Bookmarks has no product telemetry. Sync connects to X, and optional classification, Ask, repository watch, and research features connect to the providers you configure.

**Browser session sync** reads cookies from the selected browser. A local session cache may retain the required X session values for up to 30 days so scheduled sync can continue; protect the Xtreme Bookmarks data directory like a credential store.

**OAuth tokens** are stored with `chmod 600` (owner-only). Treat `~/.xtreme-bookmarks/oauth-token.json` like a password.

**The default sync uses X's internal GraphQL API**, the same API that x.com uses in your browser. For the official v2 API, use `xb auth` + `xb sync --api`.

## Maintainer release check

Run the same checks used by CI before publishing:

```bash
npm run release:check
```

The package verifier inspects npm's real dry-run manifest and fails if the CLI launcher, compiled server, or web assets are missing.

## Maintainer workflows

This project is maintained as a practical OSS tool for local-first research and agent workflows:

- Keep X/Twitter technical bookmarks available outside the platform.
- Build searchable SQLite/FTS5 indexes and markdown knowledge bases from saved posts.
- Support Chrome, Brave, and Firefox session sync where available, with OAuth/API fallback.
- Give coding agents a stable `/fieldtheory` skill surface for retrieving relevant saved context.
- Keep private user data out of the repository by default.

## License

MIT


## Ideas and Library Rail

- Capture quick ideas from the Brain or CLI.
- Tags support and promoted status.
- Library view now includes a dedicated **Ideas rail** with promoted badges, tag pills, quick promote/delete, refresh.
- Promoted ideas export to wiki + appear in graph.
