import { performance } from 'node:perf_hooks';
import { openDb, saveDb, databaseIntegrity } from '../dist/db.js';
import { twitterBookmarksIndexPath } from '../dist/paths.js';
import { initBrainSchema } from '../dist/brain.js';
import { initResearchStore, rows } from '../dist/research-store.js';
import { keywordResearch } from '../dist/research-search.js';

if(!process.env.XTREME_BOOKMARKS_DATA_DIR?.includes('preview'))throw new Error('Benchmark requires an isolated preview data directory');
const started=performance.now(),db=await openDb(twitterBookmarksIndexPath());
try{
  const opened=performance.now();initBrainSchema(db);initResearchStore(db);const indexed=performance.now();
  const count=Number(rows(db,'SELECT COUNT(*) FROM bookmarks')[0][0]);
  const samples=rows(db,"SELECT id,author_handle,text FROM bookmarks WHERE length(text)>80 ORDER BY synced_at DESC LIMIT 50");
  const timings=[];let found=0;
  for(const [id,author,text] of samples){
    const phrase=String(text).match(/[\p{L}\p{N}_]{5,}/gu)?.slice(0,4).join(' ')||'';
    const query=`${author?`@${author} `:''}${phrase}`;
    const before=performance.now();const hits=keywordResearch(db,query).slice(0,5);timings.push(performance.now()-before);
    if(hits.some(hit=>hit.bookmarkId===id))found++;
  }
  db.run('CREATE TABLE IF NOT EXISTS research_benchmark(value TEXT)');
  const beforeSave=performance.now();db.run("INSERT INTO research_benchmark VALUES('isolated write test')");saveDb(db,twitterBookmarksIndexPath());
  const saved=performance.now();timings.sort((a,b)=>a-b);
  console.log(JSON.stringify({bookmarks:count,sources:rows(db,'SELECT COUNT(*) FROM research_sources')[0][0],openMs:Math.round(opened-started),indexMs:Math.round(indexed-opened),writeAndSaveMs:Math.round(saved-beforeSave),searchP95Ms:Math.round(timings[Math.floor(timings.length*.95)]||0),exactRecallInTop5:`${found}/${samples.length}`,memoryMiB:Math.round(process.memoryUsage().rss/1024/1024),integrity:databaseIntegrity(db)},null,2));
}finally{db.close();}
