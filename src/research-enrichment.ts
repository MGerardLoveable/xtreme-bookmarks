import type { Database } from 'sql.js';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { rows, hashText, putExtractedSource } from './research-store.js';
import { dataDir, mdDir } from './paths.js';
const execute = promisify(execFile);
const VERSION = 'extract-v1';

export function publicAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a,b]=address.split('.').map(Number);
    return a<224 && ![0,10,127,169].includes(a) && !(a===172&&b>=16&&b<=31) && !(a===192&&b===168) && !(a===100&&b>=64&&b<=127) && !(a===198&&(b===18||b===19));
  }
  const value=address.toLowerCase();
  return net.isIP(address)===6 && !value.startsWith('::') && !value.startsWith('fc') && !value.startsWith('fd') && !value.startsWith('fe8') && !value.startsWith('fe9') && !value.startsWith('fea') && !value.startsWith('feb') && !value.startsWith('ff');
}
export async function publicUrl(value: string): Promise<URL> {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||(url.port&&!['443','80'].includes(url.port)))throw new Error('Only public web URLs are supported');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=net.isIP(host)?[{address:host}]:await dns.lookup(host,{all:true});
  if(!addresses.length||addresses.some(({address})=>!publicAddress(address)))throw new Error('Private network addresses are not allowed');
  return url;
}
export async function fetchPublic(value: string, maxBytes=12*1024*1024): Promise<{ data:Uint8Array; type:string; url:string }> {
  let url=value;
  for(let redirects=0;redirects<5;redirects++){
    const parsed=await publicUrl(url);
    const host=parsed.hostname.replace(/^\[|\]$/g,'');
    const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await dns.lookup(host,{all:true});
    if(!addresses.length||addresses.some(({address})=>!publicAddress(address)))throw new Error('Private network addresses are not allowed');
    const pinned=addresses[0];
    const response=await new Promise<{status:number;location?:string;type:string;data:Uint8Array}>((resolve,reject)=>{
      const client=parsed.protocol==='https:'?https:http;
      const request=client.get(parsed,{agent:false,family:pinned.family,lookup:((_host:any,_options:any,callback:any)=>callback(null,pinned.address,pinned.family)) as any,headers:{'User-Agent':'XtremeBookmarks/2 research archive'}},incoming=>{
        const status=incoming.statusCode||0,type=String(incoming.headers['content-type']||'');
        if(status>=300&&status<400){incoming.resume();resolve({status,location:incoming.headers.location,type,data:new Uint8Array()});return;}
        if(status<200||status>=300){incoming.resume();reject(new Error(`Source returned HTTP ${status}`));return;}
        if(Number(incoming.headers['content-length'])>maxBytes){incoming.destroy();reject(new Error('Source exceeds extraction size limit'));return;}
        const parts:Buffer[]=[];let size=0;
        incoming.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){incoming.destroy();reject(new Error('Source exceeds extraction size limit'));}else parts.push(chunk);});
        incoming.on('end',()=>resolve({status,type,data:new Uint8Array(Buffer.concat(parts))}));incoming.on('error',reject);
      });
      request.setTimeout(25000,()=>request.destroy(new Error('Source request timed out')));request.on('error',reject);
    });
    if(response.status>=300&&response.status<400){if(!response.location)throw new Error('Redirect has no location');url=new URL(response.location,url).href;continue;}
    return {data:response.data,type:response.type,url};
  }
  throw new Error('Too many source redirects');
}

export function enqueueEnrichment(db:Database, bookmarkId?:string, limit=100):number {
  const sourceRows=rows(db,`SELECT b.id,b.url,b.media_json,b.links_json,b.quoted_tweet_json,b.conversation_id FROM bookmarks b
    ${bookmarkId?'WHERE b.id=?':''} ORDER BY b.synced_at DESC LIMIT ?`,bookmarkId?[bookmarkId,limit]:[limit]);
  let added=0;
  const add=(id:string,kind:string,url:string,priority:number)=>{
    if(!/^https?:\/\//.test(url))return;
    db.run('INSERT OR IGNORE INTO research_jobs(id,bookmark_id,kind,url,priority) VALUES(?,?,?,?,?)',[hashText(`${VERSION}:${id}:${kind}:${url}`),id,kind,url,priority]);added+=db.getRowsModified();
  };
  for(const [id,url,mediaJson,linksJson,quotedJson,conversation] of sourceRows){
    const priority=rows(db,'SELECT 1 FROM brain_space_bookmarks WHERE bookmark_id=? LIMIT 1',[id]).length?100:10;
    let media:any[]=[];try{media=JSON.parse(mediaJson||'[]');const quoted=JSON.parse(quotedJson||'null');media.push(...(quoted?.mediaObjects||quoted?.media||[]));}catch{}
    for(const item of media){
      if(typeof item==='string'){add(id,'ocr',item,priority);continue;}
      if(['video','animated_gif'].includes(item.type)){
        const variants=(item.videoVariants||item.variants||[]).filter((v:any)=>v.contentType==='video/mp4').sort((a:any,b:any)=>(a.bitrate||0)-(b.bitrate||0));
        if(variants[0]?.url)add(id,'transcript',variants[0].url,priority);
      }else if(item.url||item.mediaUrl)add(id,'ocr',item.url||item.mediaUrl,priority);
    }
    let links:string[]=[];try{links=JSON.parse(linksJson||'[]');}catch{}
    for(const link of links.slice(0,5)){
      try{const hostname=new URL(link).hostname;if(!/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(hostname))add(id,'article',link,priority);}catch{}
    }
    if(conversation)add(id,'thread',url,priority);
  }
  return added;
}

export function extractArticle(html:string,url:string):{title:string;text:string} {
  const {document}=parseHTML(html); const article=new Readability(document as unknown as Document).parse();
  if(!article?.textContent?.trim())throw new Error('No readable article text was available');
  return {title:article.title||url,text:article.textContent.trim()};
}

let transcriber:Promise<any>|undefined;
async function transcribe(audio:Float32Array):Promise<any>{
  if(!transcriber)transcriber=import('@huggingface/transformers').then(async({pipeline,env})=>{env.cacheDir=path.join(dataDir(),'models');return pipeline('automatic-speech-recognition','Xenova/whisper-tiny',{dtype:'q8',device:'cpu'});}).catch(error=>{transcriber=undefined;throw error;});
  return (await transcriber)(audio,{chunk_length_s:30,stride_length_s:5,return_timestamps:true});
}
export async function processEnrichment(db:Database,limit=1):Promise<number>{
  const pending=rows(db,`SELECT id,bookmark_id,kind,url FROM research_jobs WHERE status='pending' AND available_at<=CURRENT_TIMESTAMP ORDER BY priority DESC,updated_at DESC LIMIT ?`,[limit]);
  let completed=0;
  for(const [id,bookmarkId,kind,url] of pending){
    db.run("UPDATE research_jobs SET status='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",[id]);
    const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'xb-extract-'));
    try{
      let text='',title=kind,result:any={method:VERSION};
      if(kind==='thread'){
        const conversation=rows(db,'SELECT conversation_id FROM bookmarks WHERE id=?',[bookmarkId])[0]?.[0];
        text=rows(db,'SELECT author_handle,text,url FROM bookmarks WHERE conversation_id=? ORDER BY posted_at LIMIT 100',[conversation]).map(([author,body,link])=>`@${author}: ${body}\n${link}`).join('\n\n');
        result={...result,coverage:'Saved posts from this conversation; unsaved replies are not included'};
      }else{
        const fetched=await fetchPublic(url,kind==='transcript'?32*1024*1024:12*1024*1024);
        const file=path.join(temporary,'source');await fs.writeFile(file,fetched.data,{mode:0o600});
        if(kind==='ocr'){
          if(!fetched.type.startsWith('image/'))throw new Error('Source is not an image');
          text=(await execute('tesseract',[file,'stdout','-l',process.env.XB_OCR_LANGUAGES||'eng'],{timeout:45000,maxBuffer:1024*1024})).stdout.trim();result={...result,method:'tesseract',asset:url};
        }else if(kind==='transcript'){
          if(!fetched.type.startsWith('video/'))throw new Error('Source is not a supported video file');
          const pcm=path.join(temporary,'audio.f32');
          await execute('ffmpeg',['-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-f','mov','-i',file,'-t','120','-ar','16000','-ac','1','-f','f32le',pcm],{timeout:45000,maxBuffer:1024*1024});
          const bytes=await fs.readFile(pcm);const speech=await transcribe(new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)));
          text=speech.text;result={...result,method:'whisper-tiny',chunks:speech.chunks,coverage:'First 120 seconds',asset:url};
        }else if(fetched.type.includes('pdf')){
          const output=path.join(temporary,'document.txt');await execute('pdftotext',['-layout',file,output],{timeout:45000,maxBuffer:1024*1024});text=await fs.readFile(output,'utf8');title='PDF';result.method='pdftotext';
        }else if(fetched.type.includes('html')){
          const article=extractArticle(Buffer.from(fetched.data).toString('utf8'),fetched.url);text=article.text;title=article.title;result.method='readability';
        }else if(fetched.type.startsWith('text/'))text=Buffer.from(fetched.data).toString('utf8');
        else throw new Error('Unsupported source format');
      }
      if(!text.trim())throw new Error('No searchable text was extracted');
      text=text.slice(0,200000);
      putExtractedSource(db,{id:`extracted:${id}`,bookmarkId,kind,body:text,url,title});
      db.run("UPDATE research_jobs SET status='complete',error=NULL,result_json=?,content_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[JSON.stringify(result),hashText(text),id]);completed++;
    }catch(error){
      const attempts=Number(rows(db,'SELECT attempts FROM research_jobs WHERE id=?',[id])[0]?.[0]??1);
      db.run("UPDATE research_jobs SET status=?,error=?,available_at=datetime('now','+1 hour'),updated_at=CURRENT_TIMESTAMP WHERE id=?",[attempts>=3?'failed':'pending',(error as Error).message.slice(0,600),id]);
    }finally{await fs.rm(temporary,{recursive:true,force:true});}
  }
  return completed;
}

export function enrichmentStatus(db:Database):unknown {
  return {counts:Object.fromEntries(rows(db,'SELECT status,COUNT(*) FROM research_jobs GROUP BY status')),recent:rows(db,'SELECT id,bookmark_id,kind,status,error,result_json,updated_at FROM research_jobs ORDER BY updated_at DESC LIMIT 30').map(([id,bookmarkId,kind,status,error,result,updatedAt])=>({id,bookmarkId,kind,status,error,result:result?JSON.parse(result):null,updatedAt}))};
}

export async function indexWikiSources(db:Database,limit=8):Promise<number> {
  let indexed=0;
  for(const folder of ['concepts','categories','domains','entities','topics']){
    const directory=path.join(mdDir(),folder);
    let files:string[]=[];try{files=await fs.readdir(directory);}catch{continue;}
    for(const file of files){
      if(!file.endsWith('.md'))continue;
      const fullPath=path.join(directory,file),stat=await fs.lstat(fullPath);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)continue;
      const relative=`${folder}/${file}`,prior=rows(db,'SELECT mtime FROM research_wiki_files WHERE path=?',[relative])[0];
      if(prior&&prior[0]===stat.mtimeMs)continue;
      const body=await fs.readFile(fullPath,'utf8'),id=`wiki:${relative}`;
      const title=body.match(/^#\s+(.+)$/m)?.[1]||file;
      db.run(`INSERT INTO research_sources(id,kind,title,body,author,captured_at,source_family) VALUES(?,'concept',?,?,'Compiled knowledge',?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,captured_at=excluded.captured_at WHERE research_sources.body<>excluded.body`,[id,title,body,new Date(stat.mtimeMs).toISOString(),id]);
      db.run('INSERT OR REPLACE INTO research_wiki_files(path,mtime) VALUES(?,?)',[relative,stat.mtimeMs]);
      if(++indexed>=limit)return indexed;
    }
  }
  return indexed;
}
