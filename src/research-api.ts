import type { Database } from 'sql.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { saveDb } from './db.js';
import { rows, researchRevision, hashText } from './research-store.js';
import { searchResearch, EMBEDDING_MODEL } from './research-search.js';
import { enqueueEnrichment, enrichmentStatus } from './research-enrichment.js';
import { liveBrief, listPlans, createPlan, updatePlan, listClaims, saveClaim, discoverConnections, scoutGaps } from './research-intelligence.js';
import { detectAvailableEngines } from './engine.js';
import crypto from 'node:crypto';
import { addBrainRepo, upsertBrainArtifactFromDb } from './brain.js';

function send(res:ServerResponse,value:unknown,status=200):void {
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));
}
async function body(req:IncomingMessage):Promise<any> {
  let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1024*1024)throw new Error('Request body is too large');}return text?JSON.parse(text):{};
}
function source(db:Database,id:string):any {
  const row=rows(db,'SELECT id,bookmark_id,space_id,kind,title,body,author,url,captured_at,source_family,withdrawn,version FROM research_sources WHERE id=?',[id])[0];
  if(!row)throw new Error('Source not found');
  const [sourceId,bookmarkId,spaceId,kind,title,text,author,url,capturedAt,family,withdrawn,version]=row;
  const extraction=rows(db,'SELECT result_json FROM research_jobs WHERE id=?',[id.replace(/^extracted:/,'')])[0]?.[0];
  return {id:sourceId,bookmarkId,spaceId,kind,title,body:text,author,url,capturedAt,family,withdrawn:Boolean(withdrawn),version,claims:listClaims(db).filter(claim=>claim.sourceId===sourceId),extraction:extraction?JSON.parse(extraction):null};
}

const TOOLS = [
  {name:'search',description:'Search saved posts, notes, extracted media and experiment results.',inputSchema:{type:'object',properties:{query:{type:'string'},spaceId:{type:'string'},limit:{type:'integer',minimum:1,maximum:30}},required:['query']}},
  {name:'fetch_source',description:'Read source text, attribution, claim status and extraction coverage.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id']}},
  {name:'workspace_brief',description:'Read workspace recommendations, uncertainties, changes and evidence.',inputSchema:{type:'object',properties:{spaceId:{type:'string'}},required:['spaceId']}},
  {name:'propose_update',description:'Store a workspace note as a proposal for review.',inputSchema:{type:'object',properties:{spaceId:{type:'string'},text:{type:'string'}},required:['spaceId','text']}},
  {name:'record_experiment',description:'Record an existing experiment result as personal experience.',inputSchema:{type:'object',properties:{planId:{type:'string'},result:{type:'string'},status:{type:'string',enum:['running','complete','rejected']}},required:['planId','result']}},
];
export interface AgentGrant { id:string; spaces:string[]; canWrite:boolean }
export function mcpAgentGrant(db:Database,req:IncomingMessage):AgentGrant|null {
  const authorization=String(req.headers.authorization||'');
  if(!authorization.startsWith('Bearer '))return null;
  const token=authorization.slice(7),row=rows(db,'SELECT id,spaces_json,can_write FROM research_agents WHERE token_hash=?',[hashText(token)])[0];
  return row?{id:String(row[0]),spaces:JSON.parse(row[1]),canWrite:Boolean(row[2])}:null;
}
function requireGrantedSource(db:Database,sourceId:string,grant?:AgentGrant|null):void {
  if(!grant)return;
  const item=source(db,sourceId);
  if(grant.spaces.includes(item.spaceId))return;
  if(item.bookmarkId&&rows(db,`SELECT 1 FROM brain_space_bookmarks WHERE bookmark_id=? AND space_id IN (${grant.spaces.map(()=>'?').join(',')}) LIMIT 1`,[item.bookmarkId,...grant.spaces]).length)return;
  throw new Error('Source is outside the agent workspace grant');
}
async function mcp(db:Database,dbPath:string,request:any,grant?:AgentGrant|null):Promise<any> {
  if(request.method==='initialize')return {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'xtreme-bookmarks',version:'3.0.0'}};
  if(request.method==='ping')return {};
  if(request.method==='tools/list')return {tools:grant&&!grant.canWrite?TOOLS.slice(0,3):TOOLS};
  if(request.method!=='tools/call')throw new Error('Method not found');
  const args=request.params?.arguments||{};let value:any;
  if(grant&&args.spaceId&&!grant.spaces.includes(args.spaceId))throw new Error('Workspace is outside the agent grant');
  if(grant&&!grant.canWrite&&['record_experiment','propose_update'].includes(request.params?.name))throw new Error('Agent has read-only access');
  switch(request.params?.name){
    case 'search': {
      const scopes=grant?(args.spaceId?[args.spaceId]:grant.spaces):[args.spaceId];
      const searches=await Promise.all(scopes.map(topicId=>searchResearch(db,String(args.query||''),{topicId,limit:Math.min(Number(args.limit)||10,30)})));
      const unique=new Map(searches.flatMap(search=>search.hits).map(hit=>[hit.id,hit]));
      value={hits:[...unique.values()].sort((a,b)=>b.score-a.score).slice(0,Math.min(Number(args.limit)||10,30)).map(hit=>({...hit,body:undefined}))};break;
    }
    case 'fetch_source':requireGrantedSource(db,String(args.id),grant);value=source(db,String(args.id));value.body=value.body.slice(0,20000);break;
    case 'workspace_brief':value=await liveBrief(db,String(args.spaceId));value.sources=value.sources.slice(0,12);break;
    case 'record_experiment':{
      if(grant&&!grant.spaces.includes(String(rows(db,'SELECT space_id FROM research_plans WHERE id=?',[args.planId])[0]?.[0])))throw new Error('Experiment is outside the agent grant');
      value=updatePlan(db,String(args.planId),{result:args.result,status:args.status||'complete'});saveDb(db,dbPath);break;
    }
    case 'propose_update': {
      if(!rows(db,'SELECT 1 FROM brain_spaces WHERE id=?',[args.spaceId]).length)throw new Error('Workspace not found');
      const text=String(args.text||'').slice(0,20000);if(!text.trim())throw new Error('Text is required');
      const id=`proposal:${hashText(`${args.spaceId}:${text}`)}`;
      db.run("INSERT OR IGNORE INTO research_sources(id,space_id,kind,title,body,author,source_family) VALUES(?,?,'proposal','Proposed workspace update',?,'Agent',?)",[id,args.spaceId,text,id]);
      saveDb(db,dbPath);value={id,status:'proposed'};break;
    }
    default:throw new Error('Unknown tool');
  }
  return {content:[{type:'text',text:JSON.stringify(value)}],isError:false};
}

export async function handleResearchApi(db:Database,dbPath:string,req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean> {
  if(!url.pathname.startsWith('/api/research/')&&url.pathname!=='/mcp')return false;
  let rpcId:unknown=null;
  try {
    if(url.pathname==='/mcp'){
      if(req.method!=='POST'){send(res,{error:'Use POST for the MCP endpoint'},405);return true;}
      const request=await body(req);rpcId=request.id??null;
      if(request.id===undefined&&request.method?.startsWith('notifications/')){res.writeHead(202);res.end();return true;}
      send(res,{jsonrpc:'2.0',id:rpcId,result:await mcp(db,dbPath,request,mcpAgentGrant(db,req))});return true;
    }
    const route=url.pathname.slice('/api/research/'.length);
    let value:unknown;let status=200;let mutate=false;
    if(route==='agents'&&req.method==='GET')value={agents:rows(db,'SELECT id,name,spaces_json,can_write,created_at FROM research_agents ORDER BY created_at DESC').map(([id,name,spaces,canWrite,createdAt])=>({id,name,spaces:JSON.parse(spaces),canWrite:Boolean(canWrite),createdAt}))};
    else if(route==='agents'&&req.method==='POST'){
      const input=await body(req),spaces=Array.isArray(input.spaces)?input.spaces.slice(0,20):[];
      if(!String(input.name||'').trim()||!spaces.length)throw new Error('An agent name and workspace are required');
      for(const id of spaces)if(!rows(db,'SELECT 1 FROM brain_spaces WHERE id=?',[id]).length)throw new Error('Workspace not found');
      const id=crypto.randomUUID(),token=`xbm_${crypto.randomBytes(32).toString('base64url')}`;
      db.run('INSERT INTO research_agents(id,name,token_hash,spaces_json,can_write) VALUES(?,?,?,?,?)',[id,String(input.name).slice(0,120),hashText(token),JSON.stringify(spaces),input.canWrite?1:0]);
      value={id,token,spaces,canWrite:Boolean(input.canWrite)};mutate=true;status=201;
    }
    else if(route.startsWith('agents/')&&req.method==='DELETE'){db.run('DELETE FROM research_agents WHERE id=?',[decodeURIComponent(route.slice(7))]);value={revoked:true};mutate=true;}
    else if(route==='status'&&req.method==='GET')value={
      sources:Number(rows(db,'SELECT COUNT(*) FROM research_sources WHERE withdrawn=0')[0][0]),embedded:Number(rows(db,'SELECT COUNT(*) FROM research_sources WHERE withdrawn=0 AND vector IS NOT NULL')[0][0]),
      model:EMBEDDING_MODEL,revision:researchRevision(db),engines:detectAvailableEngines(),enrichment:enrichmentStatus(db),
    };
    else if(route==='search'&&req.method==='GET'){
      const query=url.searchParams.get('q')||'';if(!query.trim())throw new Error('Search query is required');
      const found=await searchResearch(db,query,{topicId:url.searchParams.get('spaceId'),author:url.searchParams.get('author')||undefined,kind:url.searchParams.get('kind')||undefined,after:url.searchParams.get('after')||undefined,before:url.searchParams.get('before')||undefined,sort:url.searchParams.get('sort')||'relevance',limit:Number(url.searchParams.get('limit'))||30,offset:Number(url.searchParams.get('offset'))||0,semantic:url.searchParams.get('semantic')!=='false'});
      value={...found,hits:found.hits.map(hit=>({...hit,body:undefined}))};
    }
    else if(route.startsWith('sources/')&&req.method==='GET')value=source(db,decodeURIComponent(route.slice(8)));
    else if(route.startsWith('sources/')&&req.method==='PATCH'){
      const id=decodeURIComponent(route.slice(8)),input=await body(req);source(db,id);
      if(typeof input.withdrawn!=='boolean')throw new Error('An explicit withdrawal state is required');
      db.run('UPDATE research_sources SET withdrawn=? WHERE id=?',[input.withdrawn?1:0,id]);
      if(input.withdrawn){
        db.run(`UPDATE research_sources SET withdrawn=1 WHERE id IN (
          SELECT 'artifact:'||a.id FROM brain_artifacts a,json_each(CASE WHEN json_valid(a.raw_json) THEN a.raw_json ELSE '{}' END,'$.evidence') evidence
          WHERE a.source_type IN ('synthesis','concept') AND evidence.value=?)`,[id]);
      }
      value=source(db,id);mutate=true;
    }
    else if(route==='jobs'&&req.method==='GET')value=enrichmentStatus(db);
    else if(route==='jobs'&&req.method==='POST'){const input=await body(req);value={queued:enqueueEnrichment(db,input.bookmarkId,Math.min(Number(input.limit)||100,500))};mutate=true;status=202;}
    else if(route.startsWith('jobs/')&&req.method==='PATCH'){
      db.run("UPDATE research_jobs SET status='pending',attempts=0,error=NULL,available_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'running'",[decodeURIComponent(route.slice(5))]);value={retried:db.getRowsModified()>0};mutate=true;
    }
    else if(route==='imports'&&req.method==='GET')value={imports:rows(db,'SELECT id,mode,started_at,finished_at,status,result_json,error FROM research_imports ORDER BY id DESC LIMIT 50').map(([id,mode,startedAt,finishedAt,state,result,error])=>({id,mode,startedAt,finishedAt,status:state,result:result?JSON.parse(result):null,error}))};
    else if(route.startsWith('briefs/')&&['GET','POST'].includes(req.method||'')){value=await liveBrief(db,decodeURIComponent(route.slice(7)),req.method==='POST');mutate=true;}
    else if(route==='plans'&&req.method==='GET')value={plans:listPlans(db,url.searchParams.get('spaceId')||undefined)};
    else if(route==='plans'&&req.method==='POST'){value=await createPlan(db,await body(req));mutate=true;status=201;}
    else if(route.startsWith('plans/')&&req.method==='PATCH'){value=updatePlan(db,decodeURIComponent(route.slice(6)),await body(req));mutate=true;}
    else if(route==='claims'&&req.method==='GET')value={claims:listClaims(db)};
    else if((route==='claims'||route.startsWith('claims/'))&&['POST','PATCH'].includes(req.method||'')){
      value=saveClaim(db,await body(req),route.startsWith('claims/')?decodeURIComponent(route.slice(7)):undefined);mutate=true;status=201;
    }
    else if(route==='connections'&&req.method==='POST')value={connections:await discoverConnections(db)};
    else if(route.startsWith('connections/')&&req.method==='PATCH'){
      const input=await body(req);if(!['useful','dismissed','tried'].includes(input.response))throw new Error('Invalid feedback');
      db.run('INSERT OR REPLACE INTO research_feedback(id,response) VALUES(?,?)',[decodeURIComponent(route.slice(12)),input.response]);value={saved:true};mutate=true;
    }
    else if(route.startsWith('scout/')&&route.endsWith('/accept')&&req.method==='POST'){
      const spaceId=decodeURIComponent(route.slice(6,-7)),input=await body(req);
      if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(input.url||''))throw new Error('A GitHub repository URL is required');
      const repo=await addBrainRepo(spaceId,{repo:input.url,source:'gap-scout'});
      const artifact=upsertBrainArtifactFromDb(db,{sourceType:'web_source',sourceId:input.url,spaceId,title:String(input.title||repo.repo),body:String(input.description||`Repository ${repo.repo}`).slice(0,10000),url:input.url,author:repo.owner,sourceLabel:'GitHub discovery',capturedAt:new Date().toISOString(),rawJson:JSON.stringify({gap:input.gap,status:'accepted'})});
      value={repo,artifact};mutate=true;
    }
    else if(route.startsWith('scout/')&&req.method==='POST')value=await scoutGaps(db,decodeURIComponent(route.slice(6)));
    else {send(res,{error:'Not found'},404);return true;}
    if(mutate)saveDb(db,dbPath);send(res,value,status);return true;
  }catch(error){
    if(url.pathname==='/mcp')send(res,{jsonrpc:'2.0',id:rpcId,error:{code:-32602,message:(error as Error).message}});
    else send(res,{error:(error as Error).message},400);
    return true;
  }
}
