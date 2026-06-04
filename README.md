# Xtreme Bookmarks

Sync and store your X/Twitter bookmarks locally, browse them in the Xtreme Bookmarks web app, search them, organize them into a second brain, and use agents to keep knowledge spaces fresh.

Local-first by default: your bookmark database, media cache, generated markdown, and credentials stay on your machine unless you choose to deploy them.

## Install

Requires Node.js 20+. Chrome, Brave, or Firefox can be used for browser-session bookmark sync; OAuth/API credentials are optional for features that need official X API access.

## Quick start

```bash
# 1. Sync your bookmarks
xb sync

# 2. Search them
xb search "distributed systems"

# 3. Open the web app
xb web
```

On first run, `xb sync` uses your chosen browser session and downloads bookmarks into `~/.xtreme-bookmarks/`.

## Commands

### Sync

| Command | Description |
|---------|-------------|
| `xb sync` | Download and sync bookmarks (no API required) |
| `xb sync --full` | Full history crawl (not just incremental) |
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
| `ft skill install` | Install `/fieldtheory` skill for Claude Code and Codex |
| `ft skill show` | Print skill content to stdout |
| `ft skill uninstall` | Remove installed skill files |

### Utilities

| Command | Description |
|---------|-------------|
| `ft index` | Rebuild search index from JSONL cache (preserves classifications) |
| `ft fetch-media` | Download media assets (static images only) |
| `ft status` | Show sync status and data location |
| `ft path` | Print data directory path |

## Agent integration

Install the `/fieldtheory` skill so your agent automatically searches your bookmarks when relevant:

```bash
ft skill install     # Auto-detects Claude Code and Codex
```

Then ask your agent:

> "What have I bookmarked about cancer research in the last three years and how has it progressed?"

> "I bookmarked a number of new open source AI memory tools. Pick the best one and figure out how to incorporate it in this repo."

> "Every day please sync any new X bookmarks using the Field Theory CLI."

Works with Claude Code, Codex, or any agent with shell access.

## Scheduling

```bash
# Sync every morning at 7am
0 7 * * * ft sync

# Sync and classify every morning
0 7 * * * ft sync --classify
```

## Data

All data is stored locally at `~/.xtreme-bookmarks/`:

```
~/.xtreme-bookmarks/
  bookmarks.jsonl         # raw bookmark cache (one per line)
  bookmarks.db            # SQLite FTS5 search index
  bookmarks-meta.json     # sync metadata
  oauth-token.json        # OAuth token (if using API mode, chmod 600)
  md/                     # markdown knowledge base (ft wiki / ft md)
```

Override the location with `XTREME_BOOKMARKS_DATA_DIR`:

```bash
export XTREME_BOOKMARKS_DATA_DIR=/path/to/custom/dir
```

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

Use `ft classify` for LLM-powered classification that catches what regex misses.

## Platform support

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Session sync (`ft sync`) | Chrome, Brave, Arc, Firefox | Firefox | Firefox |
| OAuth API sync (`ft sync --api`) | Yes | Yes | Yes |
| Search, list, classify, viz, wiki | Yes | Yes | Yes |

Session sync extracts cookies from your browser's local database. Use `ft sync --browser <name>` to pick a browser. On platforms where session sync isn't available, use `ft auth` + `ft sync --api`.

## Security

**Your data stays local.** No telemetry, no analytics, nothing phoned home. The CLI only makes network requests to X's API during sync.

**Chrome session sync** reads cookies from Chrome's local database, uses them for the sync request, and discards them. Cookies are never stored separately.

**OAuth tokens** are stored with `chmod 600` (owner-only). Treat `~/.xtreme-bookmarks/oauth-token.json` like a password.

**The default sync uses X's internal GraphQL API**, the same API that x.com uses in your browser. For the official v2 API, use `ft auth` + `ft sync --api`.

## License

MIT — [fieldtheory.dev/cli](https://fieldtheory.dev/cli)

## Star History

<a href="https://www.star-history.com/?repos=afar1%2Ffieldtheory-cli&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=afar1/fieldtheory-cli&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=afar1/fieldtheory-cli&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=afar1/fieldtheory-cli&type=date&legend=top-left" />
 </picture>
</a>


## Ideas & Library Rail

- Capture quick ideas from the Brain or CLI.
- Tags support + promoted status (★).
- Library view now includes a dedicated **Ideas rail** with promoted badges, tag pills, quick promote/delete, refresh.
- Promoted ideas export to wiki + appear in graph.
