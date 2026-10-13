import type { Database } from 'sql.js';
import crypto from 'node:crypto';

export function hashText(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
export function rows(db: Database, sql: string, params: any[] = []): any[][] { return db.exec(sql, params)[0]?.values ?? []; }
export function hasTable(db: Database, name: string): boolean { return rows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0; }

export function initResearchStore(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS research_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)`);
  db.run(`INSERT OR IGNORE INTO research_meta VALUES ('revision', 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS research_sources (
    id TEXT PRIMARY KEY, bookmark_id TEXT, space_id TEXT, kind TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, author TEXT, url TEXT, captured_at TEXT,
    source_family TEXT, withdrawn INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    vector BLOB, vector_model TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS research_sources_bookmark ON research_sources(bookmark_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS research_sources_space ON research_sources(space_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS research_sources_author ON research_sources(author COLLATE NOCASE)`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS research_fts USING fts5(title, body, author, content='research_sources', content_rowid='rowid')`);
  db.run(`CREATE TRIGGER IF NOT EXISTS research_source_insert AFTER INSERT ON research_sources BEGIN
    INSERT INTO research_fts(rowid,title,body,author) VALUES(new.rowid,new.title,new.body,new.author);
    UPDATE research_meta SET value=value+1 WHERE key='revision'; END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS research_source_delete AFTER DELETE ON research_sources BEGIN
    INSERT INTO research_fts(research_fts,rowid,title,body,author) VALUES('delete',old.rowid,old.title,old.body,old.author);
    UPDATE research_meta SET value=value+1 WHERE key='revision'; END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS research_source_update AFTER UPDATE OF title,body,author,withdrawn,space_id,url,captured_at ON research_sources BEGIN
    INSERT INTO research_fts(research_fts,rowid,title,body,author) VALUES('delete',old.rowid,old.title,old.body,old.author);
    INSERT INTO research_fts(rowid,title,body,author) VALUES(new.rowid,new.title,new.body,new.author);
    UPDATE research_meta SET value=value+1 WHERE key='revision';
    UPDATE research_sources SET vector=NULL, vector_model=NULL, version=old.version+1, updated_at=CURRENT_TIMESTAMP WHERE id=new.id;
  END`);
  db.run(`CREATE TABLE IF NOT EXISTS research_jobs (
    id TEXT PRIMARY KEY, bookmark_id TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0, error TEXT, result_json TEXT, content_hash TEXT,
    available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bookmark_id,kind,url)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS research_jobs_status ON research_jobs(status,priority,available_at)`);
  db.run(`CREATE TABLE IF NOT EXISTS research_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, started_at TEXT NOT NULL,
    finished_at TEXT, status TEXT NOT NULL, result_json TEXT, error TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS research_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL, revision TEXT NOT NULL,
    document_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(space_id,revision)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS research_plans (
    id TEXT PRIMARY KEY, space_id TEXT, title TEXT NOT NULL, goal TEXT NOT NULL, success TEXT NOT NULL,
    prerequisites TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned', result TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  if(!rows(db,'PRAGMA table_info(research_plans)').some(row=>row[1]==='mode'))db.run("ALTER TABLE research_plans ADD COLUMN mode TEXT NOT NULL DEFAULT 'guided-pilot'");
  db.run(`CREATE TABLE IF NOT EXISTS research_tasks (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL,
    title TEXT NOT NULL, done_when TEXT NOT NULL, dependencies_json TEXT NOT NULL DEFAULT '[]',
    estimate TEXT, completed INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS research_claims (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, speaker TEXT NOT NULL, passage TEXT NOT NULL,
    claim TEXT NOT NULL, conditions TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'unverified',
    valid_from TEXT, valid_until TEXT, replaces TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS research_feedback (id TEXT PRIMARY KEY, response TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS research_claim_history (id INTEGER PRIMARY KEY AUTOINCREMENT,claim_id TEXT NOT NULL,document_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE INDEX IF NOT EXISTS research_claims_source ON research_claims(source_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS research_wiki_files (path TEXT PRIMARY KEY,mtime REAL NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS research_agents (id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,spaces_json TEXT NOT NULL,can_write INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  installSourceTriggers(db);
}

const definitions = [
  { table: 'bookmarks', key: 'id', prefix: 'bookmark:', select: (ref: string) => `SELECT 'bookmark:'||b.id,b.id,NULL,'bookmark',substr(b.text,1,150),b.text||char(10)||COALESCE(b.quoted_text,'')||char(10)||COALESCE(b.links_json,''),b.author_handle,b.url,COALESCE(b.bookmarked_at,b.posted_at,b.synced_at),COALESCE(b.quoted_status_id,b.id) FROM bookmarks b WHERE b.id=${ref}` },
  { table: 'bookmark_notes', key: 'bookmark_id', prefix: 'note:', select: (ref: string) => `SELECT 'note:'||n.bookmark_id,n.bookmark_id,NULL,'note','Your note',n.note,b.author_handle,b.url,n.updated_at,b.id FROM bookmark_notes n JOIN bookmarks b ON b.id=n.bookmark_id WHERE n.bookmark_id=${ref}` },
  { table: 'bookmark_highlights', key: 'id', prefix: 'highlight:', select: (ref: string) => `SELECT 'highlight:'||h.id,h.bookmark_id,NULL,'highlight','Your highlight',h.text_fragment,b.author_handle,b.url,h.created_at,b.id FROM bookmark_highlights h JOIN bookmarks b ON b.id=h.bookmark_id WHERE h.id=${ref}` },
  { table: 'brain_artifacts', key: 'id', prefix: 'artifact:', select: (ref: string) => `SELECT 'artifact:'||a.id,CASE WHEN a.source_type='bookmark' THEN a.source_id ELSE NULL END,a.space_id,a.source_type,a.title,a.body,a.author,a.url,a.captured_at,COALESCE(a.url,a.id) FROM brain_artifacts a WHERE a.id=${ref} AND NOT(a.source_type='bookmark' AND EXISTS(SELECT 1 FROM bookmarks b WHERE b.id=a.source_id AND b.text=a.body))` },
];
const columns = 'id,bookmark_id,space_id,kind,title,body,author,url,captured_at,source_family';
const upsert = `ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,author=excluded.author,url=excluded.url,captured_at=excluded.captured_at,space_id=excluded.space_id,source_family=excluded.source_family WHERE research_sources.body<>excluded.body OR research_sources.title<>excluded.title OR COALESCE(research_sources.author,'')<>COALESCE(excluded.author,'') OR COALESCE(research_sources.space_id,'')<>COALESCE(excluded.space_id,'') OR COALESCE(research_sources.url,'')<>COALESCE(excluded.url,'') OR COALESCE(research_sources.captured_at,'')<>COALESCE(excluded.captured_at,'')`;

function bookmarkProjection(db:Database,ref:string):string {
  const available=new Set(rows(db,'PRAGMA table_info(bookmarks)').map(row=>row[1]));
  const jsonText=(column:string)=>available.has(column)?`COALESCE((SELECT group_concat(j.value,' ') FROM json_tree(CASE WHEN json_valid(b.${column}) THEN b.${column} ELSE '[]' END) j WHERE j.type='text'),'')`:"''";
  const metadata=['author_name','categories','domains','url','conversation_id'].filter(column=>available.has(column)).map(column=>`COALESCE(b.${column},'')`);
  const text=["COALESCE(b.text,'')","COALESCE(b.quoted_text,'')",...['links_json','media_json','quoted_tweet_json','tags_json','github_urls'].map(jsonText),...metadata].join('||char(10)||');
  return `SELECT 'bookmark:'||b.id,b.id,NULL,'bookmark',substr(b.text,1,150),${text},b.author_handle,b.url,COALESCE(b.bookmarked_at,b.posted_at,b.synced_at),COALESCE(b.quoted_status_id,b.id) FROM bookmarks b WHERE b.id=${ref}`;
}

function installSourceTriggers(db: Database): void {
  for (const definition of definitions) {
    if (!hasTable(db, definition.table)) continue;
    const select=definition.table==='bookmarks'?(ref:string)=>bookmarkProjection(db,ref):definition.select;
    const marker = `indexed:${definition.table}${definition.table==='bookmarks'?':metadata-v2':''}`;
    if(definition.table==='bookmarks'&&!rows(db,'SELECT value FROM research_meta WHERE key=?',[marker]).length){
      db.run('DROP TRIGGER IF EXISTS research_bookmarks_insert');db.run('DROP TRIGGER IF EXISTS research_bookmarks_update');
    }
    for (const event of ['INSERT', 'UPDATE']) db.run(`CREATE TRIGGER IF NOT EXISTS research_${definition.table}_${event.toLowerCase()} AFTER ${event} ON ${definition.table} BEGIN
      INSERT INTO research_sources(${columns}) ${select(`new.${definition.key}`)} ${upsert}; END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS research_${definition.table}_delete AFTER DELETE ON ${definition.table} BEGIN
      DELETE FROM research_sources WHERE id='${definition.prefix}'||old.${definition.key}; END`);
    if (!rows(db, 'SELECT value FROM research_meta WHERE key=?', [marker]).length) {
      db.run(`INSERT INTO research_sources(${columns}) ${select(`${definition.table === 'bookmarks' ? 'b' : definition.table === 'bookmark_notes' ? 'n' : definition.table === 'bookmark_highlights' ? 'h' : 'a'}.${definition.key}`)} ${upsert}`);
      db.run('INSERT INTO research_meta(key,value) VALUES(?,1)', [marker]);
    }
  }
  if (hasTable(db, 'bookmarks')) db.run(`CREATE TRIGGER IF NOT EXISTS research_bookmark_cascade AFTER DELETE ON bookmarks BEGIN
    DELETE FROM research_sources WHERE bookmark_id=old.id;
    DELETE FROM research_jobs WHERE bookmark_id=old.id; END`);
}

export function researchRevision(db: Database): number { return Number(rows(db, "SELECT value FROM research_meta WHERE key='revision'")[0]?.[0] ?? 0); }

export function putExtractedSource(db: Database, input: { id: string; bookmarkId: string; kind: string; body: string; url: string; title?: string }): void {
  const source = rows(db, 'SELECT author_handle,bookmarked_at,url FROM bookmarks WHERE id=?', [input.bookmarkId])[0];
  if (!source) throw new Error('Bookmark not found');
  db.run(`INSERT INTO research_sources(${columns}) VALUES(?,?,NULL,?,?,?,?,?,?,?) ${upsert}`,
    [input.id,input.bookmarkId,input.kind,input.title || input.kind,input.body,source[0],input.url,source[1],input.url]);
}

export function importStart(db: Database, mode: string): number {
  db.run("INSERT INTO research_imports(mode,started_at,status) VALUES(?,?,'running')", [mode,new Date().toISOString()]);
  return Number(rows(db, 'SELECT last_insert_rowid()')[0][0]);
}
export function importFinish(db: Database, id: number, result?: unknown, error?: string): void {
  db.run('UPDATE research_imports SET finished_at=?,status=?,result_json=?,error=? WHERE id=?',
    [new Date().toISOString(),error ? 'failed' : (result as any)?.incomplete ? 'partial' : 'complete',JSON.stringify(result ?? null),error ?? null,id]);
}
