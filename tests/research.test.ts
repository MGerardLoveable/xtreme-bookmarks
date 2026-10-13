import test from 'node:test';
import assert from 'node:assert/strict';
import { openNativeDatabase } from '../src/native-db.js';
import { initBrainSchema } from '../src/brain.js';
import { initResearchStore, rows, putExtractedSource, importStart, importFinish, researchRevision } from '../src/research-store.js';
import { keywordResearch, keywordBookmarkIds, searchResearch, EMBEDDING_MODEL } from '../src/research-search.js';
import { liveBrief, listPlans, updatePlan, saveClaim, boundedResearchEvidence } from '../src/research-intelligence.js';
import { publicAddress, extractArticle, enqueueEnrichment } from '../src/research-enrichment.js';
import { mcpAgentGrant } from '../src/research-api.js';
import { hashText } from '../src/research-store.js';
import type { IncomingMessage } from 'node:http';
import { createDb } from '../src/db.js';

const nativeSupported=Number(process.versions.node.split('.')[0])>=22&&process.env.XB_TEST_SQLJS!=='1';

async function fixture() {
  const db=nativeSupported?openNativeDatabase(':memory:'):await createDb();
  db.run(`CREATE TABLE bookmarks(id TEXT PRIMARY KEY,text TEXT,quoted_text TEXT,author_handle TEXT,url TEXT,bookmarked_at TEXT,posted_at TEXT,synced_at TEXT,links_json TEXT,quoted_status_id TEXT,media_json TEXT,quoted_tweet_json TEXT,conversation_id TEXT)`);
  db.run(`CREATE TABLE bookmark_notes(bookmark_id TEXT PRIMARY KEY,note TEXT,updated_at TEXT)`);
  db.run(`CREATE TABLE bookmark_highlights(id INTEGER PRIMARY KEY,bookmark_id TEXT,text_fragment TEXT,created_at TEXT)`);
  initBrainSchema(db);
  db.run(`INSERT INTO bookmarks(id,text,author_handle,url,bookmarked_at,synced_at,links_json,media_json) VALUES('one','Robot coordination with planners and executors','alice','https://x.com/alice/status/1','2026-09-01','2026-09-01','[]','[]')`);
  db.run(`INSERT INTO bookmarks(id,text,author_handle,url,bookmarked_at,synced_at,links_json,media_json) VALUES('two','Video editing with direct engine access','bob','https://x.com/bob/status/2','2026-10-01','2026-10-01','[]','[]')`);
  db.run(`INSERT INTO brain_spaces(id,name,focus_question,created_at,updated_at,page_path) VALUES('robots','Robots','Compare coordination methods','now','now','robots.md')`);
  db.run(`INSERT INTO brain_space_bookmarks(space_id,bookmark_id,source,score,added_at) VALUES('robots','one','manual',1,'now')`);
  initResearchStore(db);return db;
}

test('unified index follows new notes, quoted text, extraction, updates and deletion', async () => {
  const db=await fixture();try {
    db.run("INSERT INTO bookmark_notes VALUES('one','Remember orchestra mode for coding agents','now')");
    assert.equal(keywordResearch(db,'orchestra')[0].kind,'note');
    const revision=researchRevision(db);
    db.run("UPDATE bookmark_notes SET note='Changed personal annotation' WHERE bookmark_id='one'");
    assert.equal(keywordResearch(db,'orchestra').length,0);assert.ok(researchRevision(db)>revision);
    putExtractedSource(db,{id:'ocr:a',bookmarkId:'two',kind:'ocr',body:'Tesseract found screenshot text about Bayesian inference',url:'https://pbs.twimg.com/image.png'});
    assert.equal(keywordResearch(db,'Bayesian')[0].bookmarkId,'two');
    db.run("DELETE FROM bookmarks WHERE id='two'");assert.equal(keywordResearch(db,'Bayesian').length,0);
  }finally{db.close();}
});

test('source scopes and chronological sorting do not leak other workspace material', async () => {
  const db=await fixture();try {
    assert.equal(keywordResearch(db,'video',{topicId:'robots'}).length,0);
    assert.equal(keywordResearch(db,'coordination',{topicId:'robots'})[0].author,'alice');
    const newest=await searchResearch(db,'coordination editing',{semantic:false,sort:'desc'});
    assert.equal(newest.hits[0].bookmarkId,'two');
    db.run("UPDATE research_sources SET withdrawn=1 WHERE id='bookmark:two'");
    const corrected=await searchResearch(db,'coordination editing',{semantic:false,sort:'desc'});
    assert.equal(corrected.hits.length,1);
  }finally{db.close();}
});

test('briefs retain revisions and detect new or changed scoped sources', async () => {
  const db=await fixture();const old=process.env.PATH;process.env.PATH='';
  try {
    const first=await liveBrief(db,'robots');const cached=await liveBrief(db,'robots');assert.equal(first.revision,cached.revision);assert.equal(cached.cached,true);
    db.run("UPDATE bookmarks SET text='Revised coordination method' WHERE id='one'");
    const changed=await liveBrief(db,'robots');assert.notEqual(changed.revision,first.revision);assert.ok(changed.changes.updated.includes('bookmark:one'));
    assert.equal(rows(db,'SELECT COUNT(*) FROM research_briefs')[0][0],2);
  }finally{process.env.PATH=old;db.close();}
});

test('claim passages must be grounded and status revisions invalidate derived state', async () => {
  const db=await fixture();try {
    assert.throws(()=>saveClaim(db,{sourceId:'bookmark:one',passage:'invented claim'}),/original source/);
    const claim=saveClaim(db,{sourceId:'bookmark:one',passage:'Robot coordination',status:'unverified'});
    assert.ok(claim.id);assert.equal(rows(db,'SELECT speaker FROM research_claims')[0][0],'alice');
  }finally{db.close();}
});

test('plan dependencies enforce order and experiment results become searchable memory', async () => {
  const db=await fixture();try {
    db.run("INSERT INTO research_plans(id,space_id,title,goal,success) VALUES('plan','robots','Pilot','Test coordination','Measured improvement')");
    db.run("INSERT INTO research_tasks(id,plan_id,position,title,done_when) VALUES('first','plan',0,'Baseline','Recorded baseline')");
    db.run(`INSERT INTO research_tasks(id,plan_id,position,title,done_when,dependencies_json) VALUES('second','plan',1,'Trial','Recorded trial','["first"]')`);
    assert.throws(()=>updatePlan(db,'plan',{taskId:'second',completed:true}),/preceding tasks/);
    updatePlan(db,'plan',{taskId:'first',completed:true});updatePlan(db,'plan',{taskId:'second',completed:true});
    updatePlan(db,'plan',{status:'complete',result:'The pilot reduced duplicate executor work'});
    assert.equal(listPlans(db)[0].tasks.filter(t=>t.completed).length,2);
    assert.equal(keywordResearch(db,'duplicate')[0].kind,'experiment');
  }finally{db.close();}
});

test('import history records partial coverage and enrichment queues deduplicate jobs', async () => {
  const db=await fixture();try {
    const id=importStart(db,'quick');importFinish(db,id,{added:12,pages:4,incomplete:true,stopReason:'rate limited'});
    assert.equal(rows(db,'SELECT status FROM research_imports')[0][0],'partial');
    db.run(`UPDATE bookmarks SET media_json='["https://pbs.twimg.com/test.jpg"]' WHERE id='one'`);
    assert.equal(enqueueEnrichment(db,'one'),1);assert.equal(enqueueEnrichment(db,'one'),0);
  }finally{db.close();}
});

test('source fetching rejects local infrastructure and article parser extracts readable text', async () => {
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.2','172.16.0.1','::1','fd00::1'])assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('8.8.8.8'),true);
  const text=extractArticle(`<html><head><title>Research</title></head><body><article><h1>Archive research</h1>${'<p>Durable memory stores useful evidence, original sources and meaningful context for future work.</p>'.repeat(12)}</article></body></html>`,'https://example.com');
  assert.match(text.text,/Durable memory/);
});

test('Smart search includes image descriptions and quoted post metadata', async () => {
  const db=await fixture();try{
    db.run(`UPDATE bookmarks SET media_json='[{"altText":"Distinctive diagram of recursive routing"}]',quoted_tweet_json='{"authorHandle":"quotedexpert","text":"A quoted observation about durable systems"}' WHERE id='one'`);
    assert.equal(keywordResearch(db,'recursive routing')[0].bookmarkId,'one');
    assert.equal(keywordResearch(db,'quotedexpert')[0].bookmarkId,'one');
    initResearchStore(db);
    assert.equal(keywordResearch(db,'recursive routing').length,1);
  }finally{db.close();}
});

test('agent tokens are hashed, scoped, and immediately revocable', async () => {
  const db=await fixture();try{
    db.run(`INSERT INTO research_agents(id,name,token_hash,spaces_json,can_write) VALUES('agent','Reader',?,'["robots"]',0)`,[hashText('private-test-token')]);
    const req={headers:{authorization:'Bearer private-test-token'}} as IncomingMessage;
    assert.deepEqual(mcpAgentGrant(db,req),{id:'agent',spaces:['robots'],canWrite:false});
    assert.equal(mcpAgentGrant(db,{headers:{authorization:'Bearer wrong-token'}} as IncomingMessage),null);
    db.run("DELETE FROM research_agents WHERE id='agent'");assert.equal(mcpAgentGrant(db,req),null);
  }finally{db.close();}
});

test('large model contexts stay valid JSON within the evidence budget', async () => {
  const packed=boundedResearchEvidence({sources:Array.from({length:80},(_,index)=>({id:`source:${index}`,body:'Long source evidence. '.repeat(2000)})),claims:[],experiments:[]});
  assert.ok(packed.length<=24000);const parsed=JSON.parse(packed);
  assert.equal(parsed.sources[0].id,'source:0');assert.ok(parsed.sources[0].body.length>0);
});

test('importer video variants without a MIME field still enqueue transcription', async () => {
  const db=await fixture();try{
    db.run('UPDATE bookmarks SET media_json=? WHERE id=?',[JSON.stringify([{type:'video',url:'https://pbs.twimg.com/preview.jpg',videoVariants:[{bitrate:256000,url:'https://video.twimg.com/clip.mp4'}]}]),'one']);
    assert.equal(enqueueEnrichment(db,'one'),2);
    assert.equal(rows(db,"SELECT kind FROM research_jobs WHERE kind='transcript'").length,1);
    assert.equal(enqueueEnrichment(db,'one'),0);
  }finally{db.close();}
});

test('workspace membership changes invalidate cached recall immediately', async () => {
  const db=await fixture();try{
    assert.equal((await searchResearch(db,'coordination',{topicId:'robots',semantic:false})).hits.length,1);
    db.run("DELETE FROM brain_space_bookmarks WHERE space_id='robots' AND bookmark_id='one'");
    assert.equal((await searchResearch(db,'coordination',{topicId:'robots',semantic:false})).hits.length,0);
  }finally{db.close();}
});

test('chronological candidate lookup includes text matches beyond the relevance window', async () => {
  const db=await fixture();try{
    db.run('BEGIN');for(let index=0;index<505;index++)db.run("INSERT INTO bookmarks(id,text,author_handle,url,bookmarked_at) VALUES(?,?,'alice','https://x.com/alice/status/9','2026-09-01')",[`chronology:${index}`,'Distinct chronology example']);db.run('COMMIT');
    assert.equal(keywordResearch(db,'chronology').length,500);
    assert.equal(keywordBookmarkIds(db,'chronology').length,505);
    assert.equal(keywordBookmarkIds(db,'chronology',{topicId:'robots'}).length,0);
  }finally{db.close();}
});
