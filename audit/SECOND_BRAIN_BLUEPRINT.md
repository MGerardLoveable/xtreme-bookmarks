# Xtreme Second Brain Blueprint

## Product Promise

Xtreme should turn a huge bookmark archive into memory that gets more useful over time. Saving is only the beginning. The system should help the user remember, understand, decide, create, and act without requiring knowledge-management expertise.

The simplest test is: after six months, does the product know more than it did today, can it explain why, and can the user put that knowledge to work in minutes?

## Research Foundation

### Andrej Karpathy: compile knowledge instead of rediscovering it

Karpathy's [LLM Wiki proposal](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) separates immutable raw sources from an LLM-maintained, interlinked wiki. New evidence updates existing entity and concept pages, flags contradictions, strengthens or challenges synthesis, and leaves a durable result. Useful answers are filed back into the wiki so exploration compounds instead of disappearing in chat history.

Product consequence: Ask cannot be the final destination. Every valuable answer needs an obvious path into a durable workspace, concept page, decision, or action.

### Garry Tan and GBrain: answers, relationships, and explicit gaps

The official [GBrain repository](https://github.com/garrytan/gbrain) frames the difference clearly: search returns pages; a brain reads across pages and gives a cited answer. Its differentiators are synthesis, graph traversal, current-vs-historical knowledge, and gap analysis.

The [recommended schema](https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_RECOMMENDED_SCHEMA.md) adds two essential rules:

- Every knowledge item has one primary home, with cross-links for its other facets.
- Every durable page has current compiled truth above an append-only evidence timeline.

Product consequence: Xtreme should present a current state of knowledge while preserving every source and change underneath it. It should say what it does not know and what may be stale.

### The complete lifecycle

The [Awesome AI Second Brain framework](https://github.com/aristoapp/awesome-second-brain) evaluates a brain across Collect, Organize, Evolve, Use, and Govern. Xtreme is already strong at Collect and increasingly strong at Use. The rebuild must concentrate on Organize, Evolve, and Govern without weakening source fidelity.

### Workflows emerging on X

Current X discussions around GBrain, LLM wikis, and personal agents consistently reward three outcomes:

- Scattered context becomes one correlated view.
- Forgotten commitments become visible actions.
- Maintenance happens automatically, but remains inspectable and reversible.

The recurring failure mode is complexity. People copy elaborate vaults and graphs, then cannot explain or trust them. Xtreme should hide technical machinery behind plain-language outcomes.

## Information Architecture

### Home: what deserves attention now

Home is the daily entry point, but it is not a chronological "Today" feed. It combines:

- Recall: a small explainable set of useful saved items.
- Continue working: active workspaces and their open questions.
- Ask shortcuts: grounded prompts derived from the archive and current work.
- Needs attention: stale claims, unresolved findings, incomplete sync, or weak knowledge areas.
- Recent progress: what the brain learned or changed, with an audit trail.

Each recall item says why it appeared and offers a direct next action: read, ask, add to workspace, remind later, mark used, or show fewer like it.

### Library: immutable evidence archive

Library remains the fast, exhaustive source browser. Search covers full tweet and quote text, notes, highlights, authors, URLs, media descriptions, tags, topics, and collections. Search supports relevance, newest, and oldest ordering.

### Ask: cited synthesis

Ask answers the question, identifies evidence and gaps, and offers reusable outputs. It should distinguish facts, inferences, conflicts, and unknowns. Evidence opens the exact saved item. Generated plans must be model-produced and evidence-aware, not sentence splitting.

### Workspaces: durable use contexts

Topics become user-facing Workspaces. A workspace can be a project, question, dossier, or subject. It owns a focus question, current summary, open threads, related sources, decisions, outputs, and evidence timeline. Collections remain lightweight filing labels rather than a competing hierarchy.

### Radar: change detection

Radar watches selected people, projects, and subjects. It reports meaningful changes and connects them to existing workspaces instead of creating a parallel feed.

## Data Contract

1. **Source**: immutable bookmark, post, note, article, or imported artifact.
2. **Knowledge item**: an entity, concept, claim, question, decision, or summary compiled from sources.
3. **Workspace**: the durable context in which knowledge is used.
4. **Relationship**: typed connection between knowledge items and sources.
5. **Timeline event**: append-only record of evidence or system change.
6. **Activation event**: evidence that knowledge was surfaced, used, corrected, dismissed, or acted on.
7. **Output**: brief, action plan, decision memo, experiment, context pack, or flashcards saved from research.

SQLite is canonical. Markdown is an inspectable export. Every compiled claim carries source IDs, timestamps, confidence, freshness, and user correction state.

## Experience Principles

- Lead with outcomes, not infrastructure terms.
- Never make the user manually maintain links or duplicate filing systems.
- Explain why something was surfaced.
- Preserve the original source and open it in one action.
- Show gaps and uncertainty as first-class information.
- Keep automated jobs bounded, resumable, and visible.
- Make every generated result editable and reusable.
- Treat correction, deletion, export, and provenance as core features.
- Prefer a small number of strong surfaces over many overlapping tabs.

## Delivery Sequence

### Phase 1: useful every time the app opens

- Add Home with Recall, Continue working, Ask shortcuts, and Needs attention.
- Reuse activation scoring behind a new user-facing recall contract.
- Give recall actions durable event tracking and immediate feedback.
- Make Home the default entry point without restoring the rejected Today feature.

### Phase 2: answers that compound

- Align Ask timeouts and retrieval behavior.
- Open evidence by immutable item ID.
- Generate action plans, decisions, and experiments through the configured model with cited source context.
- Save selected outputs into the appropriate workspace and index them for future Ask queries.

### Phase 3: compiled workspace knowledge

- Add current summary plus evidence timeline to each workspace.
- Incrementally update entities, claims, contradictions, open threads, and source counts after ingest.
- Add a review queue for suggested changes with accept, edit, or reject.

### Phase 4: trustworthy evolution

- Merge ideas into the canonical item model.
- Consolidate graph authority in SQLite.
- Add bounded maintenance jobs with checkpoints and change previews.
- Back up and restore the complete data directory.
- Add explicit external-model consent and hosted security controls.

## Success Measures

- Time from opening Xtreme to taking a useful action.
- Percentage of surfaced items that are opened, used, filed, corrected, or intentionally dismissed.
- Percentage of Ask answers with exact source navigation and explicit gaps.
- Number of durable outputs reused in a later session.
- Workspace freshness and unresolved-open-thread age.
- Data preservation rate across sync, rebuild, backup, and restore.
- Search recall for tweet text, quoted text, notes, and imported source content.

