import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { buildIndex } from '../dist/bookmarks-db.js';
import { openDb, saveDb } from '../dist/db.js';
import { initBrainSchema, createBrainSpace } from '../dist/brain.js';
import { initResearchStore, putExtractedSource } from '../dist/research-store.js';
import { embedPendingSources, searchResearch, embedText } from '../dist/research-search.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'xb-research-verification-'));
process.env.XTREME_BOOKMARKS_DATA_DIR=directory;
process.env.XB_DB_DRIVER='native';
process.env.XB_DISABLE_AUTOMATIC_BACKUPS='1';
process.env.XB_RESEARCH_SYNTHESIS='0';
const records=[
  {id:'orchestra',text:'A conductor coordinates a team of coding agents. One agent plans, specialists implement tasks, and a critic reviews the result.',authorHandle:'coordination'},
  {id:'video',text:'Tesseract provides direct video editing engine access for AI agents. Edit footage, motion graphics, sound and rendering without clicking through software.',authorHandle:'videoeditor'},
  {id:'screenshot',text:'A useful launch with a screenshot containing installation commands.',authorHandle:'screenshot'},
  {id:'memory',text:'A personal knowledge database preserves source provenance and records corrections over time.',authorHandle:'memory'},
  {id:'marketing',text:'Compare advertisement creative scores and run a controlled experiment against a baseline.',authorHandle:'marketing'},
];
for(let i=0;i<45;i++)records.push({id:`fixture-${i}`,text:`Distinct research topic number ${i}: durable knowledge and evidence for subject${i}.`,authorHandle:`person${i}`});
fs.writeFileSync(path.join(directory,'bookmarks.jsonl'),records.map((record,i)=>JSON.stringify({...record,tweetId:record.id,url:`https://x.com/${record.authorHandle}/status/${i+1}`,syncedAt:'2026-10-12T12:00:00Z',postedAt:`2026-09-${String(i%28+1).padStart(2,'0')}T12:00:00Z`,bookmarkedAt:`2026-10-${String(i%12+1).padStart(2,'0')}T12:00:00Z`,links:[],media:[]})).join('\n'));
await buildIndex();
const space=await createBrainSpace({name:'Agent Coordination',focusQuestion:'Compare multi-agent coordination methods',keywords:['coordination','agent']});
const db=await openDb(path.join(directory,'bookmarks.db'));
initBrainSchema(db);initResearchStore(db);
db.run('INSERT OR IGNORE INTO brain_space_bookmarks(space_id,bookmark_id,source,score,added_at) VALUES(?,?,?,?,?)',[space.id,'orchestra','manual',1,'2026-10-12']);
putExtractedSource(db,{id:'ocr:screenshot',bookmarkId:'screenshot',kind:'ocr',body:'Install the CLI with npm install meaningful-screenshot-command and verify the setup.',url:'https://pbs.twimg.com/example.png'});
for(let i=0;i<10;i++)db.run('INSERT OR REPLACE INTO bookmark_notes(bookmark_id,note,updated_at) VALUES(?,?,?)',[`fixture-${i}`,`Personal lesson annotation${i} about useful research`,'2026-10-12']);
if(process.argv.includes('--semantic')){
  const started=Date.now();
  for(let i=0;i<20;i++){const count=await embedPendingSources(db,8);if(!count)break;}
  console.log('Embedding finished',Date.now()-started,'ms');
  const semantic=await searchResearch(db,'multiple assistants building software together with a manager and a reviewer',{limit:5});
  assert.equal(semantic.hits[0]?.bookmarkId,'orchestra');
  console.log('Paraphrased semantic recall passed');
}
const cases=[];
for(let i=0;i<35;i++)cases.push({query:`subject${i}`,bookmarkId:`fixture-${i}`});
for(let i=0;i<10;i++)cases.push({query:`annotation${i}`,bookmarkId:`fixture-${i}`});
cases.push({query:'meaningful-screenshot-command',bookmarkId:'screenshot'},{query:'rendering',bookmarkId:'video'},{query:'critic',bookmarkId:'orchestra'},{query:'provenance',bookmarkId:'memory'},{query:'creative',bookmarkId:'marketing'});
let correct=0;const timings=[];
for(const item of cases){const started=performance.now();const result=await searchResearch(db,item.query,{semantic:false,limit:5});timings.push(performance.now()-started);if(result.hits.some(hit=>hit.bookmarkId===item.bookmarkId))correct++;}
assert.equal(correct,50);console.log('Recall fixture:',correct,'of',cases.length,'expected sources in top 5; p95',timings.sort((a,b)=>a-b)[Math.floor(timings.length*.95)].toFixed(1),'ms');
assert.equal((await searchResearch(db,'video',{topicId:space.id,semantic:false})).hits.length,0);
saveDb(db,path.join(directory,'bookmarks.db'));db.close();
console.log('Verification data:',directory);
if(process.argv.includes('--browser')){
  const {chromium}=await import(process.env.XB_PLAYWRIGHT_MODULE || 'playwright');
  const server=spawn(process.execPath,['dist/cli.js','web','--port','3862'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,XTREME_BOOKMARKS_NO_OPEN:'1',XB_SEMANTIC_SEARCH:'0',XB_WEB_PASSWORD:'verification-password'},stdio:['ignore','pipe','pipe']});
  let serverOutput='';server.stdout.on('data',data=>serverOutput+=data);server.stderr.on('data',data=>serverOutput+=data);
  let browser;
  try{
    for(let i=0;i<100;i++){if(serverOutput.includes('running at'))break;if(server.exitCode!==null)throw new Error(serverOutput);await new Promise(resolve=>setTimeout(resolve,100));}
    browser=await chromium.launch({headless:true,channel:'chrome'});
    for(const width of [1400,848,390]){
      const page=await browser.newPage({httpCredentials:{username:'xtreme',password:'verification-password'},viewport:{width,height:1000}});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto('http://127.0.0.1:3862/#/topics/research');
      await page.locator('.research-search-form').waitFor();
      await page.locator('.research-query input').fill('meaningful-screenshot-command');await page.locator('.research-search-form').getByRole('button',{name:'Search',exact:true}).click();
      await page.locator('.research-result').first().waitFor();
      await page.locator('.research-result-title').first().click();await page.locator('dialog[open]').waitFor();
      assert.match(await page.locator('.research-source-text').textContent(),/meaningful-screenshot-command/);
      await page.locator('[data-close-dialog]').click();
      for(const mode of ['workspaces','actions','connections','claims','imports','agents']){
        await page.locator(`[data-research-mode="${mode}"]`).click();
        await page.locator({workspaces:'.research-brief-heading',actions:'.research-plan-form',connections:'[data-discover]',claims:'.research-claims',imports:'.research-table-wrap',agents:'.research-agent-form'}[mode]).waitFor();
        assert.equal(await page.locator(`[data-research-mode="${mode}"]`).getAttribute('aria-pressed'),'true');
        if(mode==='actions'&&width===1400){
          await page.locator('.research-plan-form [name="goal"]').fill('Compare coding agent coordination on one small task');
          await page.locator('.research-plan-form [name="success"]').fill('Record a measurable result against a baseline');
          await page.locator('.research-plan-form button[type="submit"]').click();
          await page.locator('.research-plan').first().waitFor();
          const checkboxes=page.locator('.research-plan').first().locator('[data-task]');
          assert.equal(await checkboxes.count(),4);
          await checkboxes.first().check();
          await page.locator('.research-plan [data-plan-result]').first().fill('The coordination pilot reduced duplicated implementation work');
          await page.locator('.research-plan [data-save-result]').first().click();
        }
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
        assert.equal(overflow,false,`${width}/${mode} horizontal overflow`);
        await page.screenshot({path:path.join(directory,`${width}-${mode}.png`)});
      }
      const auth=Buffer.from('xtreme:verification-password').toString('base64');
      const rpc=await fetch('http://127.0.0.1:3862/mcp',{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(response=>response.json());
      assert.equal(rpc.result.tools.length,5);
      assert.equal((await fetch('http://127.0.0.1:3862/mcp',{method:'POST',body:'{}'})).status,401);
      if(width===1400){
        const ownerHeaders={Authorization:`Basic ${auth}`,'Content-Type':'application/json'};
        const grant=await fetch('http://127.0.0.1:3862/api/research/agents',{method:'POST',headers:ownerHeaders,body:JSON.stringify({name:'Scope verification',spaces:[space.id]})}).then(response=>response.json());
        assert.ok(grant.token);
        const agentCall=async(name,args)=>fetch('http://127.0.0.1:3862/mcp',{method:'POST',headers:{Authorization:`Bearer ${grant.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})}).then(response=>response.json());
        const scoped=await agentCall('search',{query:'rendering'});assert.ok(JSON.parse(scoped.result.content[0].text).hits.every(hit=>hit.bookmarkId==='orchestra'||hit.spaceId===space.id));
        assert.match((await agentCall('fetch_source',{id:'bookmark:video'})).error.message,/outside/);
        assert.match((await agentCall('propose_update',{spaceId:space.id,text:'Denied write'})).error.message,/read-only/);
        const allowed=await agentCall('fetch_source',{id:'bookmark:orchestra'});assert.ok(allowed.result);
        const agents=await fetch('http://127.0.0.1:3862/api/research/agents',{headers:ownerHeaders}).then(response=>response.json());
        assert.equal(JSON.stringify(agents).includes(grant.token),false);
        await fetch(`http://127.0.0.1:3862/api/research/agents/${grant.id}`,{method:'DELETE',headers:ownerHeaders});
        assert.equal((await fetch('http://127.0.0.1:3862/mcp',{method:'POST',headers:{Authorization:`Bearer ${grant.token}`},body:'{}'})).status,401);
        console.log('Scoped agent read, write denial, and revocation passed');
      }
      assert.deepEqual(errors,[]);console.log('Browser passed:',width);await page.close();
    }
  }finally{await browser?.close();server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
}
