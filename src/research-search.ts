import type { Database } from 'sql.js';
import path from 'node:path';
import { dataDir } from './paths.js';
import { databaseCacheKey } from './db.js';
import { buildSearchPlan } from './search.js';
import { rows, researchRevision } from './research-store.js';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const STOPWORDS = new Set(['a','an','and','are','as','at','be','by','can','do','for','from','have','how','i','in','is','it','me','my','of','on','or','that','the','their','this','to','was','were','what','when','where','which','with','you']);
let extractor: Promise<any> | undefined;
let reranker: Promise<any> | undefined;
const queryVectors = new Map<string, number[]>();

async function rerankHits(query:string,hits:ResearchHit[]):Promise<ResearchHit[]> {
  if(!reranker)reranker=import('@huggingface/transformers').then(async({AutoTokenizer,AutoModelForSequenceClassification,env})=>{
    env.cacheDir=path.join(dataDir(),'models');
    const model='Xenova/ms-marco-MiniLM-L-6-v2';
    return {tokenizer:await AutoTokenizer.from_pretrained(model),model:await AutoModelForSequenceClassification.from_pretrained(model,{dtype:'q8',device:'cpu'})};
  }).catch(error=>{reranker=undefined;throw error;});
  const {tokenizer,model}=await reranker;
  const ranked:Array<{hit:ResearchHit;score:number}>=[];
  for(const hit of hits.slice(0,20)){
    const input=await tokenizer(query,{text_pair:hit.body.slice(0,3500),truncation:true,max_length:256});
    const output=await model(input);ranked.push({hit,score:Number(output.logits.data[0])});
  }
  return [...ranked.sort((a,b)=>b.score-a.score).map(({hit})=>({...hit,matchedBy:[...hit.matchedBy,'reranked']})),...hits.slice(20)];
}

export async function embedText(text: string): Promise<number[]> {
  if (!extractor) extractor = import('@huggingface/transformers').then(async ({ pipeline, env }) => {
    env.cacheDir = path.join(dataDir(), 'models');
    env.backends.onnx.logLevel = 'error';
    return pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8', device: 'cpu' });
  }).catch((error) => { extractor = undefined; throw error; });
  const vector = await (await extractor)(text.slice(0, 3500), { pooling: 'mean', normalize: true });
  return Array.from(vector.data as Float32Array);
}

export async function embedPendingSources(db: Database, limit = 8): Promise<number> {
  const batch = rows(db, `SELECT id,version,title,body FROM research_sources WHERE withdrawn=0 AND vector IS NULL
    ORDER BY CASE WHEN space_id IS NOT NULL OR EXISTS(SELECT 1 FROM brain_space_bookmarks sb WHERE sb.bookmark_id=research_sources.bookmark_id) THEN 0 ELSE 1 END,
    captured_at DESC LIMIT ?`, [limit]);
  let completed = 0;
  for (const [id,version,title,body] of batch) {
    const vector = new Float32Array(await embedText(`${title}\n${body}`));
    db.run('UPDATE research_sources SET vector=?,vector_model=? WHERE id=? AND version=? AND withdrawn=0', [new Uint8Array(vector.buffer),EMBEDDING_MODEL,id,version]);
    completed++;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return completed;
}

export interface ResearchSearchOptions {
  topicId?: string | null; author?: string; kind?: string; after?: string; before?: string;
  limit?: number; offset?: number; sort?: string; semantic?: boolean;
  category?: string; domain?: string; collection?: string; readStatus?: string;
}
export interface ResearchHit {
  id: string; bookmarkId: string | null; spaceId: string | null; kind: string; title: string;
  body: string; author: string; url: string; capturedAt: string; family: string;
  score: number; matchedBy: string[]; excerpt: string;
}

export function researchScope(options: ResearchSearchOptions): { sql: string; params: any[] } {
  const clauses = ['s.withdrawn=0']; const params: any[] = [];
  if (options.topicId) { clauses.push('(s.space_id=? OR EXISTS(SELECT 1 FROM brain_space_bookmarks sb WHERE sb.space_id=? AND sb.bookmark_id=s.bookmark_id))'); params.push(options.topicId,options.topicId); }
  if (options.author) { clauses.push('s.author=? COLLATE NOCASE'); params.push(options.author.replace(/^@/,'')); }
  if (options.kind) { clauses.push('s.kind=?'); params.push(options.kind); }
  if (options.after) { clauses.push('s.captured_at>=?'); params.push(options.after); }
  if (options.before) { clauses.push('s.captured_at<=?'); params.push(/^\d{4}-\d{2}-\d{2}$/.test(options.before)?`${options.before}T23:59:59.999Z`:options.before); }
  if (options.category) { clauses.push('EXISTS(SELECT 1 FROM bookmarks b WHERE b.id=s.bookmark_id AND b.categories LIKE ?)'); params.push(`%${options.category}%`); }
  if (options.domain) { clauses.push('EXISTS(SELECT 1 FROM bookmarks b WHERE b.id=s.bookmark_id AND b.domains LIKE ?)'); params.push(`%${options.domain}%`); }
  if (options.collection) { clauses.push('EXISTS(SELECT 1 FROM bookmark_collections c WHERE c.bookmark_id=s.bookmark_id AND c.collection_name=?)'); params.push(options.collection); }
  if (options.readStatus) { clauses.push(`COALESCE((SELECT is_read FROM bookmark_read_status r WHERE r.bookmark_id=s.bookmark_id),0)=?`); params.push(options.readStatus==='read' ? 1 : 0); }
  return { sql: clauses.join(' AND '), params };
}

const sourceColumns = 's.id,s.bookmark_id,s.space_id,s.kind,s.title,s.body,s.author,s.url,s.captured_at,s.source_family';
function hitFromRow(row: any[]): ResearchHit {
  return { id:String(row[0]),bookmarkId:row[1] ? String(row[1]) : null,spaceId:row[2] ? String(row[2]) : null,kind:String(row[3]),title:String(row[4]),body:String(row[5]),author:String(row[6]??''),url:String(row[7]??''),capturedAt:String(row[8]??''),family:String(row[9]??row[0]),score:0,matchedBy:[],excerpt:'' };
}
export function keywordResearch(db: Database, query: string, options: ResearchSearchOptions = {}): ResearchHit[] {
  const plan = buildSearchPlan(query);
  const meaningful=plan.tokens.filter(token=>!STOPWORDS.has(token));
  const ftsQuery=meaningful.map(token=>`"${token.replace(/"/g,'""')}"${token.length>=3?'*':''}`).join(' OR ');
  const strictQuery=meaningful.map(token=>`"${token.replace(/"/g,'""')}"${token.length>=3?'*':''}`).join(' AND ');
  const scope = researchScope({ ...options, author:options.author ?? plan.author, category:options.category ?? plan.category,domain:options.domain ?? plan.domain });
  if(!ftsQuery){
    if(!plan.author&&!plan.category&&!plan.domain)return [];
    return rows(db,`SELECT ${sourceColumns} FROM research_sources s WHERE ${scope.sql} ORDER BY s.captured_at DESC LIMIT 500`,scope.params).map((row,index)=>({...hitFromRow(row),score:1/(61+index),matchedBy:['filter'],excerpt:String(row[5]).slice(0,450)}));
  }
  // An author-index-first join repeats the FTS scan for every post by that author.
  const find=(search:string)=>rows(db, `SELECT ${sourceColumns},bm25(research_fts,3,1,2)
    FROM research_sources s NOT INDEXED JOIN research_fts f ON f.rowid=s.rowid
    WHERE research_fts MATCH ? AND ${scope.sql} ORDER BY bm25(research_fts,3,1,2) LIMIT 500`, [search,...scope.params]);
  const strict=find(strictQuery);
  return (strict.length?strict:find(ftsQuery))
    .map((row,index) => ({ ...hitFromRow(row), score:1/(60+index+1), matchedBy:['text'],excerpt:excerptFor(String(row[5]),plan.tokens) }));
}

function excerptFor(body: string, terms: string[]): string {
  const lower=body.toLowerCase(); const locations=terms.map((t)=>lower.indexOf(t)).filter((n)=>n>=0);
  const start=Math.max(0,(locations.length ? Math.min(...locations) : 0)-100);
  return `${start ? '...' : ''}${body.slice(start,start+450)}${body.length>start+450 ? '...' : ''}`;
}
const cachedResults = new WeakMap<object, Map<string, { revision:number; hits:ResearchHit[]; embedded:number }>>();
export async function searchResearch(db: Database, query: string, options: ResearchSearchOptions = {}): Promise<{ hits:ResearchHit[]; total:number; embedded:number; revision:number }> {
  const plan=buildSearchPlan(query); const resolved={...options,author:options.author??plan.author,category:options.category??plan.category,domain:options.domain??plan.domain};
  const revision=researchRevision(db);
  const embedded=Number(rows(db,'SELECT COUNT(*) FROM research_sources WHERE vector IS NOT NULL AND withdrawn=0')[0]?.[0]??0);
  const key=JSON.stringify([query,{...resolved,offset:undefined,limit:undefined},embedded]);
  const databaseKey=databaseCacheKey(db);
  let cache=cachedResults.get(databaseKey); if(!cache){cache=new Map();cachedResults.set(databaseKey,cache);}
  let hits=cache.get(key)?.revision===revision ? cache.get(key)!.hits : undefined;
  if(!hits){
    const keywords=keywordResearch(db,query,resolved); const combined=new Map(keywords.map((hit)=>[hit.id,hit]));
    if(resolved.semantic!==false && embedded>0){
      try {
        let vector=queryVectors.get(query); if(!vector){vector=await embedText(plan.text||query);if(queryVectors.size>100)queryVectors.clear();queryVectors.set(query,vector);}
        const scope=researchScope(resolved); const semantic:Array<{id:string;similarity:number}>=[];
        // Stream vectors without materializing the full archive's bodies in memory.
        const statement=db.prepare(`SELECT s.id,s.vector FROM research_sources s WHERE ${scope.sql} AND s.vector_model=?`);
        statement.bind([...scope.params,EMBEDDING_MODEL]);
        try{while(statement.step()){
          const row=statement.get(),bytes=row[1] as Uint8Array; if(!bytes || bytes.byteLength!==vector.length*4)continue;
          const values=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
          let similarity=0;for(let i=0;i<values.length;i++)similarity+=values[i]*vector[i];
          if(similarity>=0.15)semantic.push({id:String(row[0]),similarity});
        }}finally{statement.free();}
        semantic.sort((a,b)=>b.similarity-a.similarity);
        semantic.slice(0,100).forEach(({id},index)=>{
          const row=rows(db,`SELECT ${sourceColumns} FROM research_sources s WHERE s.id=?`,[id])[0];
          const hit=combined.get(id) ?? {...hitFromRow(row),excerpt:excerptFor(String(row[5]),plan.tokens)};
          hit.score+=1/(60+index+1);hit.matchedBy.push('meaning');combined.set(hit.id,hit);
        });
      } catch(error){console.error('Semantic search unavailable:',(error as Error).message);}
    }
    hits=[...combined.values()].sort((a,b)=>b.score-a.score);
    if(resolved.semantic!==false&&embedded>0&&plan.tokens.filter(token=>!STOPWORDS.has(token)).length>=4&&hits.length>1){
      try{hits=await rerankHits(plan.text||query,hits);}catch(error){console.error('Relevance reranking unavailable:',(error as Error).message);}
    }
    if(options.sort==='asc'||options.sort==='oldest')hits.sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt));
    if(options.sort==='desc'||options.sort==='newest')hits.sort((a,b)=>b.capturedAt.localeCompare(a.capturedAt));
    if(cache.size>50)cache.clear();cache.set(key,{revision,hits,embedded});
  }
  const offset=Math.max(0,options.offset??0),limit=Math.max(1,Math.min(options.limit??30,500));
  return {hits:hits.slice(offset,offset+limit),total:hits.length,embedded,revision};
}

export function researchEvidence(db: Database, query: string, options:ResearchSearchOptions={}): any[] {
  return hitsAsEvidence(keywordResearch(db,query,options).slice(0,options.limit??30),db);
}
export function hitsAsEvidence(hits:ResearchHit[],db?:Database):any[] {
  return hits.map((hit)=>({
    id:hit.id,itemId:hit.bookmarkId||hit.id,kind:['bookmark','note','highlight','synthesis','concept','x_feed','web_source'].includes(hit.kind)?hit.kind:'web_source',
    title:hit.title,excerpt:[...(db?rows(db,'SELECT status,passage,conditions FROM research_claims WHERE source_id=?',[hit.id]).map(([status,passage,conditions])=>`Claim review: ${status}. Passage: ${passage}. Conditions: ${conditions}`):[]),hit.body.slice(0,3500)].join('\n'),url:hit.url||null,score:hit.score,
    provenance:{sourceType:hit.kind,sourceId:hit.bookmarkId||hit.id,sourceUrl:hit.url,sourceLabel:hit.kind==='note'?'Your note':hit.author?`@${hit.author}`:hit.kind,capturedAt:hit.capturedAt}
  }));
}
