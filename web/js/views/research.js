import { api, fmtNumber } from '../api.js';
import { escape, toast } from '../util.js';
import { renderIcons } from '../icons.js';

const MODES = { search: ['Search', 'search'], workspaces: ['Briefs', 'folder-kanban'], actions: ['Plans', 'check-circle'], connections: ['Connections', 'network'], claims: ['Evidence', 'message-circle'], imports: ['Imports', 'download-cloud'], agents: ['Agents', 'shield-check'] };
const date = value => value ? new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).toLocaleString() : '';
const author = value => value && value !== 'You' && value !== 'Agent' ? `@${value.replace(/^@/, '')}` : value || 'Saved source';
function link(url, label) { return /^https?:\/\//.test(url || '') ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>` : escape(label); }

export function ResearchView(root) {
  let mode = 'search', active = true, generation = 0;
  let spaces = [], status = null, sourceItem = null, selectedSpace = '', lastConnections = null, scoutFindings = [];
  root.innerHTML = `<div class="research-workbench">
    <div class="research-health" aria-live="polite"></div>
    <nav class="toolbar-segment research-modes" aria-label="Research views">${Object.entries(MODES).map(([id, [label, icon]]) => `<button class="segment-btn" data-research-mode="${id}"><span data-icon="${icon}"></span>${label}</button>`).join('')}</nav>
    <div class="research-content"></div>
    <dialog class="research-source-dialog"><div class="research-dialog-content"></div></dialog>
  </div>`;
  const content = root.querySelector('.research-content'), dialog = root.querySelector('dialog');
  const choices = () => `<option value="">All workspaces</option>${spaces.map(s => `<option value="${escape(s.id)}" ${selectedSpace === s.id ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}`;
  function icons() { renderIcons(root); }
  function loading() { content.innerHTML = '<div class="research-loading" role="status">Loading research...</div>'; }
  function error(err) { content.innerHTML = `<p class="research-error" role="alert">${escape(err.message)}</p>`; }
  async function refreshStatus() {
    status = await api.research('status');
    root.querySelector('.research-health').innerHTML = `<span><strong>${fmtNumber(status.sources)}</strong> searchable sources</span><span><strong>${fmtNumber(status.embedded)}</strong> indexed by meaning</span><span><strong>${fmtNumber(status.enrichment.counts.pending || 0)}</strong> extractions pending</span><span>${status.engines.length ? `Synthesis: ${escape(status.engines.join(', '))}` : 'Synthesis provider not connected'}</span>`;
  }
  async function openSource(id) {
    sourceItem = await api.research(`sources/${encodeURIComponent(id)}`);
    const s = sourceItem;
    root.querySelector('.research-dialog-content').innerHTML = `<header><div><small>${escape(s.kind)} · ${escape(author(s.author))}</small><h2>${escape(s.title)}</h2></div><button class="icon-btn" data-close-dialog aria-label="Close source"><span data-icon="x"></span></button></header>
      <div class="research-source-meta">${link(s.url, 'Original source')} · ${escape(date(s.capturedAt))}${s.extraction?.coverage ? ` · ${escape(s.extraction.coverage)}` : ''}</div>
      <button class="btn btn-sm" data-withdraw-source>${s.withdrawn ? 'Include in recall' : 'Exclude from recall'}</button>
      ${s.kind==='ocr'?`<img class="research-source-image" src="${escape(s.extraction?.asset||s.url)}" alt="Original screenshot" loading="lazy" referrerpolicy="no-referrer">`:''}
      ${s.kind==='transcript'?`<video class="research-source-video" src="${escape(s.extraction?.asset||s.url)}" controls preload="none"></video>`:''}
      <div class="research-source-text">${escape(s.body)}</div>
      ${s.extraction?.chunks?.length ? `<div class="research-transcript">${s.extraction.chunks.map(chunk => `<p><a href="${escape(s.url)}#t=${Number(chunk.timestamp?.[0] || 0)}" target="_blank" rel="noopener noreferrer">${Math.floor(chunk.timestamp?.[0] || 0)}s</a> ${escape(chunk.text)}</p>`).join('')}</div>` : ''}
      <form class="research-claim-form"><h3>Track a claim</h3><label>Exact evidence passage<textarea class="input" name="passage" required rows="3"></textarea></label><label>Claim<input class="input" name="claim" placeholder="The statement you want to evaluate"></label><label>Conditions<input class="input" name="conditions" placeholder="Version, benchmark, or assumptions"></label><label>Status<select class="input" name="status"><option>unverified</option><option>supported</option><option>disputed</option><option>superseded</option><option>withdrawn</option></select></label><button class="btn btn-primary" type="submit"><span data-icon="plus"></span>Save claim</button></form>`;
    icons(); if (!dialog.open) dialog.showModal();
  }
  function sourceRows(hits) {
    return hits.map(hit => `<article class="research-result"><div class="research-result-meta">${escape(author(hit.author))}<span>${escape(hit.kind)}</span><span>${escape((hit.matchedBy || []).join(' + '))}</span></div>
      <button class="research-result-title" data-source="${escape(hit.id)}">${escape(hit.title)}</button><p>${escape(hit.excerpt || hit.body?.slice(0, 450) || '')}</p><footer>${link(hit.url, 'Open original')}<button class="btn btn-sm btn-ghost" data-source="${escape(hit.id)}"><span data-icon="message-circle"></span>Inspect evidence</button></footer></article>`).join('') || '<p class="research-empty">No matching sources.</p>';
  }
  async function showSearch() {
    content.innerHTML = `<form class="research-search-form"><label class="research-query"><span data-icon="search"></span><input class="input" name="q" aria-label="Search research" placeholder="What do you remember?" required></label><button class="btn btn-primary" type="submit">Search</button><div class="research-filters"><select class="input" name="spaceId" aria-label="Workspace">${choices()}</select><select class="input" name="kind" aria-label="Content type"><option value="">All content</option>${['bookmark','note','highlight','ocr','transcript','article','thread','experiment'].map(k=>`<option>${k}</option>`).join('')}</select><select class="input" name="sort" aria-label="Result order"><option value="relevance">Best match</option><option value="desc">Newest saved</option><option value="asc">Oldest saved</option></select><label>From<input class="input" name="after" type="date"></label><label>Until<input class="input" name="before" type="date"></label></div></form><div class="research-results"><p class="research-empty">Your posts, notes, highlights, and extracted text.</p></div>`;
    content.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault(); const button=event.target.querySelector('button'); button.disabled=true;
      const params=new URLSearchParams(new FormData(event.target));
      try { const result=await api.research(`search?${params}`);content.querySelector('.research-results').innerHTML=`<div class="research-result-count">${fmtNumber(result.total)} matches</div>${sourceRows(result.hits)}`;icons(); }
      catch(err){toast(err.message,'error');}finally{button.disabled=false;}
    }); icons();
  }
  async function showWorkspaces() {
    if(!spaces.length){content.innerHTML='<p class="research-empty">Create a workspace in Overview to build a live brief.</p>';return;}
    selectedSpace ||= spaces[0].id;
    content.innerHTML=`<div class="research-section-toolbar"><select class="input" id="research-space" aria-label="Workspace">${choices()}</select><button class="btn" data-refresh-brief><span data-icon="refresh-cw"></span>Refresh brief</button><button class="btn" data-scout><span data-icon="radar"></span>Research gaps</button></div><div class="research-live-brief"></div>`;
    content.querySelector('select').value=selectedSpace;
    content.querySelector('select').addEventListener('change',async event=>{selectedSpace=event.target.value;if(selectedSpace)await renderBrief();});
    await renderBrief();
  }
  async function renderBrief(refresh=false) {
    const panel=content.querySelector('.research-live-brief');if(!panel)return;
    panel.innerHTML='<p role="status">Preparing workspace brief...</p>';
    const brief=await api.research(`briefs/${encodeURIComponent(selectedSpace)}`,refresh?{method:'POST'}:{});
    if(!panel.isConnected)return;
    panel.innerHTML=`<div class="research-brief-heading"><small>Revision ${brief.version} · ${escape(date(brief.updatedAt))} · ${escape(brief.mode)}</small><h2>${escape(brief.title)}</h2><p>${escape(brief.goal)}</p></div>
      <section class="research-band"><h3>Current picture</h3><p>${escape(brief.overview)}</p><h3>Recommended approach <small>Inference</small></h3><p>${escape(brief.recommendation)}</p>${brief.alternatives.map(a=>`<p><strong>${escape(a.title)}</strong> ${escape(a.tradeoff)}</p>`).join('')}</section>
      <section class="research-band"><h3>What changed</h3><p>${brief.changes.added.length} new · ${brief.changes.updated.length} updated · ${brief.changes.removed.length} removed sources</p>${brief.changes.notes.map(note=>`<p>${escape(note)}</p>`).join('')}</section>
      <section class="research-band"><h3>Next steps</h3><ol>${brief.nextActions.map(a=>`<li><strong>${escape(a.title)}</strong><p>Done when: ${escape(a.doneWhen)}</p>${a.evidenceIds.map(id=>`<button class="btn btn-xs" data-source="${escape(id)}">Evidence</button>`).join('')}</li>`).join('')}</ol><button class="btn btn-primary" data-plan-goal="${escape(brief.goal)}"><span data-icon="check-circle"></span>Create plan</button></section>
      <section class="research-band"><h3>Open questions</h3><ul>${brief.uncertainties.map(q=>`<li>${escape(q)}</li>`).join('')}</ul></section>
      <details class="research-band"><summary>Evidence · ${brief.sources.length} sources</summary>${sourceRows(brief.sources.slice(0,12))}</details><div class="research-scout-results"></div>`;icons();
  }
  async function showActions() {
    const {plans}=await api.research('plans');
    if(mode!=='actions')return;
    content.innerHTML=`<form class="research-plan-form"><h2>New experiment or action plan</h2><label>Outcome<textarea class="input" name="goal" rows="2" required placeholder="What should be different when this works?"></textarea></label><div class="research-filters"><select class="input" name="spaceId" aria-label="Workspace">${choices()}</select><input class="input" name="success" aria-label="Success criterion" placeholder="How will you know it worked?"></div><button class="btn btn-primary" type="submit"><span data-icon="plus"></span>Create plan</button></form><div class="research-plans">${plans.map(plan=>`<article class="research-plan" data-plan="${escape(plan.id)}"><header><h3>${escape(plan.title)}</h3><select class="input" data-plan-status aria-label="Plan status">${['planned','running','complete','rejected'].map(s=>`<option ${s===plan.status?'selected':''}>${s}</option>`).join('')}</select></header><small>${plan.mode==="model-plan"?"Model-generated plan":"Guided pilot"}</small><p>${escape(plan.goal)}</p><p><strong>Success:</strong> ${escape(plan.success)}</p><p><strong>Prerequisites:</strong> ${escape(plan.prerequisites)}</p><ol>${plan.tasks.map(task=>`<li><label><input type="checkbox" data-task="${escape(task.id)}" ${task.completed?'checked':''}><strong>${escape(task.title)}</strong></label><p>${escape(task.doneWhen)}</p><small>${escape(task.estimate)}</small></li>`).join('')}</ol><details><summary>Evidence · ${plan.evidence.length}</summary>${plan.evidence.map(e=>`<p>${link(e.url,author(e.author))} ${escape(e.title)}</p>`).join('')}</details><label class="research-result-label">Observed result<textarea class="input" data-plan-result rows="3" placeholder="What worked, what failed, and what would you do next?">${escape(plan.result)}</textarea></label><button class="btn" data-save-result><span data-icon="check"></span>Save result</button></article>`).join('')||'<p class="research-empty">No plans yet.</p>'}</div>`;
    content.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;button.textContent='Building plan...';
      try{await api.research('plans',{body:Object.fromEntries(new FormData(event.target))});await showActions();icons();}catch(err){toast(err.message,'error');button.disabled=false;button.textContent='Create plan';}
    });icons();
  }
  async function showClaims() {
    const {claims}=await api.research('claims');
    if(mode!=='claims')return;
    content.innerHTML=`<h2>Claims and evidence</h2><div class="research-claims">${claims.map(c=>`<article class="research-result"><div class="research-result-meta">${link(c.url,author(c.speaker))}<span>${escape(c.status)}</span></div><h3>${escape(c.claim)}</h3><blockquote>${escape(c.passage)}</blockquote><p>${escape(c.conditions||'Conditions not recorded')}</p><small>${escape(date(c.validFrom))}${c.validUntil?` to ${escape(date(c.validUntil))}`:''}</small><div class="research-section-toolbar"><button class="btn btn-sm" data-source="${escape(c.sourceId)}">Original evidence</button><select class="input" data-claim="${escape(c.id)}" aria-label="Claim status">${['unverified','supported','disputed','superseded','withdrawn'].map(s=>`<option ${s===c.status?'selected':''}>${s}</option>`).join('')}</select></div></article>`).join('')||'<p class="research-empty">Inspect a search result to track a claim and its original passage.</p>'}</div>`;
    content.querySelectorAll('[data-claim]').forEach(select=>select.addEventListener('change',async()=>{const claim=claims.find(c=>c.id===select.dataset.claim);await api.research(`claims/${encodeURIComponent(claim.id)}`,{method:'PATCH',body:{...claim,status:select.value}});toast('Claim updated');}));icons();
  }
  async function showConnections() {
    content.innerHTML=`<div class="research-section-toolbar"><h2>Connections between workspaces</h2><button class="btn" data-discover><span data-icon="sparkles"></span>Find connections</button></div><div class="research-connection-results"></div>`;
    if(lastConnections)renderConnections(lastConnections);icons();
  }
  function renderConnections(connections) {
    content.querySelector('.research-connection-results').innerHTML=connections.map(c=>`<article class="research-result"><small>Hypothesis</small><h3>${escape(c.title)}</h3><p>${escape(c.reason)}</p><div class="research-connection-pair">${c.sources.map(s=>`<div><small>${escape(spaces.find(w=>w.id===s.spaceId)?.name||'Workspace')}</small><button class="research-result-title" data-source="${escape(s.id)}">${escape(s.title)}</button><p>${escape(s.body.slice(0,250))}</p></div>`).join('')}</div><p><strong>Small test:</strong> ${escape(c.test)}</p><footer>${['useful','dismissed','tried'].map(response=>`<button class="btn btn-sm" data-feedback="${escape(c.id)}" data-response="${response}">${response==='dismissed'?'Not relevant':response==='tried'?'Already tried':'Useful'}</button>`).join('')}</footer></article>`).join('')||'<p class="research-empty">Add related source material to two different workspaces to discover connections.</p>';icons();
  }
  async function showImports() {
    const {imports}=await api.research('imports'),jobs=await api.research('jobs');
    if(mode!=='imports')return;
    content.innerHTML=`<div class="research-section-toolbar"><h2>Import and extraction history</h2><button class="btn" data-queue><span data-icon="layers"></span>Extract recent sources</button><button class="icon-btn" data-refresh-imports aria-label="Refresh import history"><span data-icon="refresh-cw"></span></button></div>
      <div class="research-table-wrap"><table><thead><tr><th>Started</th><th>Mode</th><th>Status</th><th>New</th><th>Scanned / existing</th><th>Pages</th><th>Stopping reason</th></tr></thead><tbody>${imports.map(run=>`<tr><td>${escape(date(run.startedAt))}</td><td>${escape(run.mode)}</td><td>${escape(run.status)}</td><td>${fmtNumber(run.result?.added||0)}</td><td>${fmtNumber(run.result?.scanned||0)} / ${fmtNumber(run.result?.existingSeen||0)}</td><td>${run.result?.pages??'—'}</td><td>${escape(run.error||run.result?.stopReason||'In progress')}${run.result?.lastCursor?'<br>Backfill can resume':''}</td></tr>`).join('')||'<tr><td colspan="7">No imports recorded since this upgrade.</td></tr>'}</tbody></table></div>
      <h3>Extracted content</h3><p>${Object.entries(jobs.counts).map(([state,count])=>`${fmtNumber(count)} ${escape(state)}`).join(' · ')||'No extraction jobs yet'}</p><div class="research-job-list">${jobs.recent.map(job=>`<div class="research-job"><span>${escape(job.kind)}</span><strong>${escape(job.status)}</strong><p>${escape(job.error||job.result?.coverage||'')}</p>${job.status==='failed'?`<button class="btn btn-xs" data-retry="${escape(job.id)}">Retry</button>`:''}</div>`).join('')}</div>`;icons();
  }
  async function showAgents() {
    const {agents}=await api.research('agents');
    if(mode!=='agents')return;
    content.innerHTML=`<form class="research-agent-form"><h2>Agent access</h2><label>Name<input class="input" name="name" required maxlength="120" placeholder="My research assistant"></label><fieldset><legend>Workspaces</legend>${spaces.map(space=>`<label><input type="checkbox" name="spaces" value="${escape(space.id)}">${escape(space.name)}</label>`).join('')||'<p>No workspaces yet.</p>'}</fieldset><label><input type="checkbox" name="canWrite">Allow proposals and experiment results</label><button class="btn btn-primary" type="submit" ${spaces.length?'':'disabled'}><span data-icon="shield-check"></span>Create access</button></form><div class="research-agent-secret" aria-live="polite"></div><div class="research-agents">${agents.map(agent=>`<article class="research-result"><h3>${escape(agent.name)}</h3><p>${agent.spaces.map(id=>escape(spaces.find(space=>space.id===id)?.name||id)).join(', ')}</p><small>${agent.canWrite?'Proposals and results':'Read only'} · ${escape(date(agent.createdAt))}</small><button class="btn btn-sm" data-revoke-agent="${escape(agent.id)}"><span data-icon="trash"></span>Revoke access</button></article>`).join('')}</div>`;
    content.querySelector('form').addEventListener('submit',async event=>{
      event.preventDefault();const values=new FormData(event.target),button=event.target.querySelector('button');button.disabled=true;
      try{const grant=await api.research('agents',{body:{name:values.get('name'),spaces:values.getAll('spaces'),canWrite:values.has('canWrite')}});await showAgents();
        const panel=content.querySelector('.research-agent-secret');if(!panel)return;
        panel.innerHTML=`<section class="research-band"><h3>New connection</h3><label>MCP endpoint<input class="input" readonly value="${escape(location.origin)}/mcp"></label><label>Bearer token<input class="input" readonly type="password" autocomplete="off" value="${escape(grant.token)}"></label><button class="btn btn-sm" data-copy-agent-token><span data-icon="copy"></span>Copy token</button><small>This token is shown only for this connection. Revoking access disables it immediately.</small></section>`;
        panel.querySelector('button').addEventListener('click',async()=>{await navigator.clipboard.writeText(grant.token);toast('Token copied');});icons();
      }catch(err){toast(err.message,'error');button.disabled=false;}
    });icons();
  }
  async function show(next=mode) {
    mode=next;const ticket=++generation;root.querySelectorAll('[data-research-mode]').forEach(button=>{button.classList.toggle('active',button.dataset.researchMode===mode);button.setAttribute('aria-pressed',String(button.dataset.researchMode===mode));});loading();
    try { if(!spaces.length)spaces=(await api.brainSpaces()).spaces||[];if(ticket!==generation)return;
      await ({search:showSearch,workspaces:showWorkspaces,actions:showActions,connections:showConnections,claims:showClaims,imports:showImports,agents:showAgents})[mode]();
    } catch(err){error(err);}icons();
  }
  root.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.researchMode){await show(button.dataset.researchMode);return;}
    if(button.hasAttribute('data-close-dialog')){dialog.close();return;}
    const run=async(fn)=>{button.disabled=true;try{await fn();}catch(err){toast(err.message,'error');}finally{button.disabled=false;}};
    if(button.hasAttribute('data-withdraw-source'))await run(async()=>{await api.research(`sources/${encodeURIComponent(sourceItem.id)}`,{method:'PATCH',body:{withdrawn:!sourceItem.withdrawn}});await openSource(sourceItem.id);});
    else if(button.dataset.source)await run(()=>openSource(button.dataset.source));
    else if(button.hasAttribute('data-refresh-brief'))await run(()=>renderBrief(true));
    else if(button.hasAttribute('data-scout'))await run(async()=>{const result=await api.research(`scout/${encodeURIComponent(selectedSpace)}`,{method:'POST'});const panel=content.querySelector('.research-scout-results');if(!panel)return;scoutFindings=result.findings;panel.innerHTML=`<section class="research-band"><h3>${escape(result.gap)}</h3><p>${link(result.searches.x,'Search X')} · ${link(result.searches.github,'Search GitHub')}</p>${result.findings.map((f,index)=>`<article class="research-result"><h3>${link(f.url,f.title)}</h3><small>Candidate · ${escape(date(f.updatedAt))}</small><p>${escape(f.description||'')}</p><button class="btn btn-sm" data-accept-discovery="${index}"><span data-icon="plus"></span>Add to workspace</button></article>`).join('')}</section>`;icons();});
    else if(button.hasAttribute('data-accept-discovery'))await run(async()=>{await api.research(`scout/${encodeURIComponent(selectedSpace)}/accept`,{body:scoutFindings[Number(button.dataset.acceptDiscovery)]});button.textContent='Added';button.removeAttribute('data-accept-discovery');toast('Repository added to workspace');});
    else if(button.dataset.revokeAgent)await run(async()=>{await api.research(`agents/${encodeURIComponent(button.dataset.revokeAgent)}`,{method:'DELETE'});await showAgents();});
    else if(button.hasAttribute('data-plan-goal'))await run(async()=>{await api.research('plans',{body:{spaceId:selectedSpace,goal:button.dataset.planGoal}});await show('actions');});
    else if(button.hasAttribute('data-save-result'))await run(async()=>{const plan=button.closest('[data-plan]');await api.research(`plans/${plan.dataset.plan}`,{method:'PATCH',body:{result:plan.querySelector('[data-plan-result]').value}});toast('Result saved to research memory');});
    else if(button.hasAttribute('data-discover'))await run(async()=>{lastConnections=(await api.research('connections',{method:'POST'})).connections;renderConnections(lastConnections);});
    else if(button.dataset.feedback)await run(async()=>{await api.research(`connections/${button.dataset.feedback}`,{method:'PATCH',body:{response:button.dataset.response}});button.closest('article').remove();});
    else if(button.hasAttribute('data-queue'))await run(async()=>{const result=await api.research('jobs',{body:{limit:100}});toast(`${result.queued} sources queued`);await showImports();});
    else if(button.hasAttribute('data-refresh-imports'))await run(showImports);
    else if(button.dataset.retry)await run(async()=>{await api.research(`jobs/${button.dataset.retry}`,{method:'PATCH',body:{}});await showImports();});
  });
  root.addEventListener('change',async event=>{
    const plan=event.target.closest('[data-plan]');if(!plan)return;
    try{if(event.target.dataset.task)await api.research(`plans/${plan.dataset.plan}`,{method:'PATCH',body:{taskId:event.target.dataset.task,completed:event.target.checked}});
      else if(event.target.hasAttribute('data-plan-status'))await api.research(`plans/${plan.dataset.plan}`,{method:'PATCH',body:{status:event.target.value}});
    }catch(err){toast(err.message,'error');if(event.target.type==='checkbox')event.target.checked=!event.target.checked;}
  });
  root.addEventListener('submit',async event=>{
    if(!event.target.matches('.research-claim-form'))return;event.preventDefault();
    try{await api.research('claims',{body:{...Object.fromEntries(new FormData(event.target)),sourceId:sourceItem.id,speaker:sourceItem.author}});dialog.close();toast('Claim saved');await show('claims');}catch(err){toast(err.message,'error');}
  });
  const interval=setInterval(()=>{if(active)refreshStatus().catch(()=>{});},30000);
  icons();
  return {onShow(){active=true;refreshStatus().catch(error);const params=new URLSearchParams(location.hash.split('?')[1]||'');show(MODES[params.get('mode')]?params.get('mode'):mode);if(params.get('source'))openSource(params.get('source')).catch(err=>toast(err.message,'error'));},onHide(){active=false;if(dialog.open)dialog.close();},onRoute(){const params=new URLSearchParams(location.hash.split('?')[1]||'');if(MODES[params.get('mode')])show(params.get('mode'));if(params.get('source'))openSource(params.get('source')).catch(err=>toast(err.message,'error'));},destroy(){clearInterval(interval);}};
}
