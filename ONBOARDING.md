# Xtreme Bookmarks Onboarding

## What This Product Is

Xtreme Bookmarks is a local-first research memory built around a large X bookmark archive. It imports and preserves posts, makes their full text searchable, supports notes and reading state, answers questions with cited evidence, and organizes sources into durable knowledge workspaces.

The product should feel like a personal research assistant, not a database admin tool. A user should be able to answer four questions quickly:

1. What deserves my attention?
2. What do I already know about this?
3. Where did that claim come from?
4. What can I do with it now?

## System Map

- `src/graphql-bookmarks.ts` and `src/bookmarks.ts`: X bookmark acquisition and resumable backfill.
- `src/bookmarks-db.ts`: canonical bookmark indexing and full-text search maintenance.
- `src/web-server.ts`: HTTP API and local application server.
- `src/activation.ts`: bookmark intent, enrichment, review scoring, claims, and recall queue state.
- `src/brain.ts`: workspaces, memory artifacts, entities, relationships, findings, and maintenance workflows.
- `src/md-ask.ts`: retrieval and cited answer generation.
- `src/knowledge-service.ts`: canonical topics, items, annotations, and evidence access.
- `web/js/views/`: Library, Ask, Topics, Radar, and the user-facing workflows.
- `bookmarks.db` in the configured data directory: canonical SQLite database. Generated Markdown is an export and browsing surface, not a second authority. See README.md for setup and migration instructions.

## Product Strengths

- More than 64,000 bookmarks remain inspectable as original sources.
- Tweet text, quoted text, notes, highlights, authors, URLs, media metadata, topics, and collections participate in full-text search.
- Bookmark acquisition is resumable and preserves X ordering when the source exposes it.
- Ask can synthesize across saved sources and expose evidence.
- Topics already model projects, questions, dossiers, and durable subject areas.
- Activation state supports intent, importance, why-saved notes, review dates, and action history.

## Important Risks

- Database rebuilds must preserve every user-authored child record. Notes, activation profiles, workspace roles, and artifacts need reconciliation or foreign-key guarantees.
- Quick ideas must become first-class knowledge items. A separate JSONL idea store is easy to omit from Ask, backup, and graph workflows.
- SQLite should remain the canonical graph and artifact store. Generated `md/graph.json` must not become an independent source of truth.
- Ask timeouts must agree across browser, server, and model execution.
- Evidence links should open an immutable source by item ID, not rerun a text search that can change.
- Background bookmark sync must use the same completeness and checkpoint guarantees as manual Grab.
- Backups must cover the complete user data directory, not only `bookmarks.db`.
- Hosted or multi-user operation needs real authentication, source isolation, signed webhooks, rate limiting, security headers, and explicit consent before content is sent to an external model.

## Product Direction

The archive is the evidence layer. The product compounds value above it:

1. Preserve the original source.
2. Compile sources into current topic and entity knowledge.
3. Keep an append-only evidence timeline behind every current summary.
4. Surface contradictions, stale claims, missing context, and open questions.
5. Recall useful material in the context of active work.
6. Turn answers into briefs, decisions, plans, experiments, and reusable context packs.
7. Let the user inspect, correct, delete, export, and understand every automated change.

See `audit/SECOND_BRAIN_BLUEPRINT.md` for the source-backed design and implementation sequence.

## Verification Baseline

Before shipping a change:

1. Run TypeScript type checking.
2. Run the complete automated test suite.
3. Build production assets.
4. Start the local server on a free port.
5. Verify the affected workflow in the browser at desktop and mobile widths.
6. Confirm the browser console and relevant network requests are clean.
7. Confirm existing user-authored data remains present after any migration or rebuild.
