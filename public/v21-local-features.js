(function(root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const DAYS = [['1','Monday'],['2','Tuesday'],['3','Wednesday'],['4','Thursday'],['5','Friday'],['6','Saturday'],['0','Sunday']];
  const BANDS = [['onTrack','On track'],['busy','Busy'],['overloaded','Overloaded'],['critical','Critical']];
  const DEFAULT_BANDS = {onTrack:50,busy:80,overloaded:100,critical:120};
  let core, installed=false, busy=false, recoveryChoice='', ui={}, formDirty=false;
  function validateWorkload(capacities,bands) {
    if (DAYS.some(([d])=>!Number.isInteger(capacities[d]) || capacities[d]<30 || capacities[d]>1440)) return 'Daily limits must be whole minutes from 30 to 1,440.';
    const numbers=BANDS.map(([key])=>bands[key]);
    if (numbers.some((v,i)=>!Number.isInteger(v) || v<1 || v>500 || (i && v<=numbers[i-1]))) return 'Percentages must increase: On track < Busy < Overloaded < Critical, from 1% to 500%.';
    return '';
  }
  function reorder(source,ids,id,direction) {
    const at=ids.indexOf(id), to=at+direction;
    if (![1,-1].includes(direction) || at<0 || to<0 || to>=ids.length || new Set(ids).size!==ids.length) return null;
    const next=clone(source), ordered=ids.slice();
    [ordered[at],ordered[to]]=[ordered[to],ordered[at]];
    const map=new Map(next.tasks.map(t=>[t.id,t]));
    if(ordered.some(key=>!map.has(key) || map.get(key).done)) return null;
    ordered.forEach((key,i)=>{map.get(key).priority=i;});
    return next;
  }
  function bandPreview(capacity,bands) {
    return `Light: below ${bands.onTrack}% (${Math.ceil(capacity*bands.onTrack/100)} min). `+BANDS.map(([k,label])=>`${label}: ${bands[k]}%+ (${Math.ceil(capacity*bands[k]/100)} min+)`).join(' · ');
  }
  const byId=id=>root.document?.getElementById(id);
  function note(message,error=false) {
    const el=byId('v21Message');
    if(el){el.textContent=message;el.dataset.error=String(error);}
  }
  function remember(key,value) {
    ui[key]=value;
    try{root.localStorage.setItem(core.storageKey()+'_v21_ui',JSON.stringify(ui));}catch{note('This view preference could not be saved. Your task data is unchanged.',true);}
  }
  function blockEditing(message) {
    if(!root.document) return;
    const app=root.document.querySelector('.app');
    // Block task/settings mutations but keep our independent recovery controls available.
    root.document.querySelectorAll('.main,.tabs,.header').forEach(el=>{el.inert=true;});
    note(message || 'Device recovery needs attention. Export a backup or retry before editing.',true);
    byId('v21Help')?.scrollIntoView({block:'start'});
  }
  function unblockEditing(){root.document.querySelectorAll('.main,.tabs,.header').forEach(el=>{el.inert=false;});}
  function collapseSidebar() {
    const list=byId('catList'), trash=byId('catTrashBtn');
    if(!list || !trash || byId('v21Categories')) return;
    const sidebar=list.parentElement;
    const heading=list.previousElementSibling;
    const details=root.document.createElement('details'); details.id='v21Categories'; details.className='v21-collapse'; details.open=ui.categories===true;
    details.innerHTML='<summary>Categories</summary>';
    sidebar.insertBefore(details,heading); heading.hidden=true;
    details.appendChild(list);
    const add=sidebar.querySelector('.add-cat-btn:not(#catTrashBtn)'); if(add)details.appendChild(add);
    details.addEventListener('toggle',()=>{if(details.open!==!!ui.categories)remember('categories',details.open);});
    const noDate=byId('unscheduledList')?.parentElement;
    if(noDate) trash.after(noDate);
    for(const [text,key] of [['Sort Tasks By','sort'],['Filter','filter']]) {
      const title=[...sidebar.querySelectorAll('.sidebar-title')].find(el=>el.textContent.trim()===text);
      if(!title)continue;
      const section=title.parentElement, group=root.document.createElement('details'); group.className='v21-collapse'; group.id='v21'+key; group.open=ui[key]===true;
      group.innerHTML=`<summary>${text}</summary>`;
      section.before(group); title.hidden=true;group.appendChild(section);
      group.addEventListener('toggle',()=>{if(group.open!==!!ui[key])remember(key,group.open);});
    }
    const sort=byId('v21sort');
    if(sort) {const b=root.document.createElement('button');b.className='btn btn-ghost';b.textContent='My order';b.onclick=()=>{core.setManualSort();remember('manualSort',true);};sort.appendChild(b);}
  }
  function taskArrows() {
    root.document.querySelectorAll('[id^="list_"]').forEach(list=>{
      const rows=[...list.querySelectorAll('.task-item[data-id]:not(.done)')];
      rows.forEach((row,i)=>{
        if(row.querySelector('.v21-order'))return;
        const meta=row.querySelector('.task-meta'); if(!meta)return;
        const group=root.document.createElement('span');group.className='v21-order';group.setAttribute('role','group');group.setAttribute('aria-label','Task order');
        for(const [direction,label,symbol] of [[-1,'Move task up','↑'],[1,'Move task down','↓']]) {
          const button=root.document.createElement('button');button.type='button';button.className='btn btn-ghost';button.textContent=symbol;button.title=label;button.setAttribute('aria-label',label);button.disabled=(direction<0?i===0:i===rows.length-1);
          button.onclick=async event=>{
            event.preventDefault();event.stopPropagation();if(busy)return;
            const ids=rows.map(r=>r.dataset.id), before=clone(core.getState());
            const next=reorder(before,ids,row.dataset.id,direction);if(!next)return;
            busy=true;
            try{core.setState(next);await core.save();core.setManualSort();remember('manualSort',true);note('Task order saved. Urgency labels and dates are unchanged.');}
            catch(error){note(error.message,true);blockEditing('The order could not be saved reliably. Export your draft and retry recovery.');}
            finally{busy=false;enhance();}
          };
          group.appendChild(button);
        }
        const category=meta.querySelector('.task-cat-badge'); if(category)meta.insertBefore(group,category);else meta.prepend(group);
      });
    });
  }
  function ensureWorkload() {
    const trash=byId('profileTrashBtn'); if(!trash || byId('v21Workload'))return;
    const panel=root.document.createElement('section');panel.id='v21Workload';panel.className='v21-panel';
    panel.innerHTML=`<h3>Daily capacity / overload threshold</h3><p>Warnings use all planned minutes. A finished day shows Complete.</p>
      <label>Daily limits <select id="v21CapacityMode" class="form-input"><option value="all">Same limit for all dates</option><option value="weekday">Different limits by weekday</option></select></label>
      <label id="v21AllLabel">All dates (minutes)<input id="v21AllCapacity" class="form-input" type="number" min="30" max="1440" step="1"></label>
      <div id="v21WeekdayFields" class="v21-grid">${DAYS.map(([d,n])=>`<label>${n}<input class="form-input" data-v21-day="${d}" type="number" min="30" max="1440" step="1"></label>`).join('')}</div>
      <details><summary>More workload settings</summary><p>Set the percentage where each status begins. Minute equivalents update with the daily limit.</p>
      <div class="v21-grid">${BANDS.map(([k,n])=>`<label>${n} (%)<input class="form-input" data-v21-band="${k}" type="number" min="1" max="500" step="1"></label>`).join('')}</div>
      <div id="v21BandPreview" role="status"></div></details>
      <div class="v21-actions"><button type="button" class="btn btn-primary" id="v21SaveWorkload">Save workload settings</button><button type="button" class="btn btn-ghost" id="v21ResetWorkload">Restore defaults</button><button type="button" class="btn btn-ghost" id="v21CancelWorkload">Cancel changes</button></div><p id="v21WorkloadMessage" role="status"></p>`;
    trash.parentElement.after(panel);
    panel.addEventListener('input',()=>{formDirty=true;previewWorkload();});
    byId('v21CapacityMode').onchange=()=>{formDirty=true;previewWorkload();};
    byId('v21CancelWorkload').onclick=()=>fillWorkload();
    byId('v21ResetWorkload').onclick=()=>{fillWorkload(true);formDirty=true;byId('v21WorkloadMessage').textContent='Default values are ready. Choose Save workload settings to apply them.';};
    byId('v21SaveWorkload').onclick=saveWorkload;
    fillWorkload();
  }
  function readWorkload() {
    const same=byId('v21CapacityMode').value==='all', capacities={},bands={};
    DAYS.forEach(([d])=>capacities[d]=Number(same?byId('v21AllCapacity').value:root.document.querySelector(`[data-v21-day="${d}"]`).value));
    BANDS.forEach(([k])=>bands[k]=Number(root.document.querySelector(`[data-v21-band="${k}"]`).value));
    return {capacities,bands};
  }
  function fillWorkload(defaults=false) {
    if(!byId('v21Workload'))return;
    const capacities=defaults?Object.fromEntries(DAYS.map(([d])=>[d,240])):root.StudyQuestV19.effectiveCapacityValues(core.getState());
    const bands=defaults?DEFAULT_BANDS:root.StudyQuestV19.normalizeWorkloadSettings(core.getState()._studyquestV19WorkloadSettings).statusBandPercents;
    byId('v21CapacityMode').value=new Set(Object.values(capacities)).size===1?'all':'weekday';
    byId('v21AllCapacity').value=capacities['1'];
    DAYS.forEach(([d])=>root.document.querySelector(`[data-v21-day="${d}"]`).value=capacities[d]);
    BANDS.forEach(([k])=>root.document.querySelector(`[data-v21-band="${k}"]`).value=bands[k]);
    formDirty=false;byId('v21WorkloadMessage').textContent='Changes apply only when you save.';previewWorkload();
  }
  function previewWorkload() {
    const all=byId('v21CapacityMode').value==='all';byId('v21AllLabel').hidden=!all;byId('v21WeekdayFields').hidden=all;
    const {capacities,bands}=readWorkload(),error=validateWorkload(capacities,bands);
    byId('v21BandPreview').textContent=error || (all?'All dates: '+bandPreview(capacities['1'],bands):DAYS.map(([d,n])=>n+': '+bandPreview(capacities[d],bands)).join('\n'));
    if(formDirty)byId('v21WorkloadMessage').textContent=error || 'Unsaved changes.';
  }
  async function saveWorkload() {
    if(busy)return;
    const {capacities,bands}=readWorkload(), error=validateWorkload(capacities,bands);
    if(error){byId('v21WorkloadMessage').textContent=error;return;}
    const before=clone(core.getState()),next=clone(before);
    next._studyquestV17Settings={...next._studyquestV17Settings,version:1,weekdayCapacityMinutes:capacities};
    next._studyquestV19WorkloadSettings={...next._studyquestV19WorkloadSettings,schemaVersion:1,statusBandPercents:bands};
    if(JSON.stringify(before)===JSON.stringify(next)){fillWorkload();return;}
    busy=true;byId('v21SaveWorkload').disabled=true;
    try{core.setState(next);await core.save();formDirty=false;core.render();byId('v21WorkloadMessage').textContent='Saved on this laptop. Account sync uses the existing protected connection.';}
    catch(e){byId('v21WorkloadMessage').textContent=e.message;blockEditing('The workload save needs attention. Export your draft and retry recovery.');}
    finally{busy=false;byId('v21SaveWorkload').disabled=false;}
  }
  // One screen: differences, any unresolved choices, and a single labelled Apply.
  function recoveryApplyLabel(other) {
    return recoveryChoice==='copy' ? `Load ${other.toLowerCase()}` : 'Apply reviewed merge';
  }
  function recoveryBlockReason(preview) {
    if(preview.smartMerge?.size?.overLimit) return 'This combination is over the size limit. Remove some content, then review again.';
    if(recoveryChoice==='merge' && preview.smartMerge?.unresolved) return `Choose the ${preview.smartMerge.unresolved} highlighted difference${preview.smartMerge.unresolved===1?'':'s'} below to continue.`;
    if(recoveryChoice==='copy' && preview.sourceType==='import') return 'An imported file must be applied as a reviewed merge.';
    return '';
  }
  function showRecovery(reset=true) {
    const preview=core.getPreview();
    if(!preview)return;
    const mergeable=!!preview.smartMerge;
    if(reset)recoveryChoice=mergeable?'merge':'copy';
    if(recoveryChoice==='merge'&&!mergeable)recoveryChoice='copy';
    root.closeModal?.('liveSyncConflictModal');root.closeModal?.('liveSyncComparisonModal');
    let modal=byId('v21RecoveryModal');
    if(!modal){modal=root.document.createElement('div');modal.id='v21RecoveryModal';modal.className='modal-overlay';modal.innerHTML='<div class="modal v21-recovery" role="dialog" aria-modal="true" aria-labelledby="v21RecoveryTitle"></div>';root.document.body.appendChild(modal);}
    const other=preview.sourceType==='local-server'?'Laptop disk backup':'Account backup (online)';
    const summary=s=>`${(s?.tasks||[]).length} tasks · ${(s?.notes||[]).length} notes · ${(s?.tracker?.weeks||[]).length} weeks`;
    const blocked=recoveryBlockReason(preview);
    const content=modal.firstElementChild;
    content.innerHTML=`<h2 id="v21RecoveryTitle">Recover your saved copies</h2>
      <p>Nothing changes until you choose Apply. Both copies stay preserved. A larger task count alone does not identify the correct copy.</p>
      <div class="v21-grid"><div class="v21-panel"><strong>This laptop</strong><p>${summary(preview.localState)}</p></div><div class="v21-panel"><strong>${other}</strong><p>${summary(preview.cloudState)}</p></div></div>
      <div class="v21-choice" role="radiogroup" aria-label="What to keep">
        ${mergeable?`<button type="button" class="btn btn-ghost" role="radio" aria-checked="${recoveryChoice==='merge'}" data-v21-choice="merge">Combine changes from both copies<small>Keeps changes found on either side. Reviewed before it is applied.</small></button>`:''}
        <button type="button" class="btn btn-ghost" role="radio" aria-checked="${recoveryChoice==='copy'}" data-v21-choice="copy">Load ${other.toLowerCase()} on this laptop<small>Replaces this laptop's working copy. Changes found only here stay archived.</small></button>
      </div>
      <div class="v21-differences-wrap"><h3>Differences</h3><div class="v21-differences">${core.details(preview)}</div></div>
      ${blocked?`<p id="v21RecoveryBlocked" role="status" data-error="true">${escape(blocked)}</p>`:''}
      <div class="v21-actions"><button class="btn btn-ghost" id="v21RecoveryExport">Download both copies</button><button class="btn btn-ghost" id="v21RecoveryLater">Decide later</button><button class="btn btn-primary" id="v21RecoveryApply" ${blocked?'disabled':''}>${escape(recoveryApplyLabel(other))}</button></div>
      <p id="v21RecoveryMessage" role="status"></p>`;
    byId('v21RecoveryExport').onclick=async()=>{try{core.download(await core.snapshots());byId('v21RecoveryMessage').textContent='Download requested. Check your Downloads folder before continuing.';}catch(e){byId('v21RecoveryMessage').textContent=e.message;}};
    byId('v21RecoveryLater').onclick=()=>root.closeModal('v21RecoveryModal');
    content.querySelectorAll('[data-v21-choice]').forEach(b=>b.onclick=()=>{recoveryChoice=b.dataset.v21Choice;showRecovery(false);});
    byId('v21RecoveryApply').onclick=async()=>{
      if(busy||recoveryBlockReason(preview))return;busy=true;content.querySelectorAll('button,input,select').forEach(el=>{el.disabled=true;});
      byId('v21RecoveryMessage').textContent='Applying your choice. Do not close this tab.';
      try{if(recoveryChoice==='copy')await core.loadReviewedCopy();else await core.applyReviewedMerge();root.closeModal('v21RecoveryModal');note('Reviewed copy saved on this laptop. Use Check sync to compare with the account.');}
      catch(e){showRecovery(false);byId('v21RecoveryMessage').textContent=e.message;}
      finally{busy=false;}
    };
    root.openModal('v21RecoveryModal');
  }
  function enhance(){if(!installed)return;collapseSidebar();taskArrows();ensureWorkload();}
  function install(bridge) {
    if(installed || !root.document)return;installed=true;core=bridge;
    try{ui=JSON.parse(root.localStorage.getItem(core.storageKey()+'_v21_ui')||'{}');}catch{ui={};}
    const style=root.document.createElement('style');style.textContent=`
      .v21-collapse{margin:12px 0;border:1px solid var(--border);border-radius:10px;padding:10px}.v21-collapse summary{cursor:pointer;font-weight:700;min-height:28px}.v21-panel{padding:14px;border:1px solid var(--border);border-radius:12px;margin:12px 0;min-width:0}.v21-panel p,.v21-recovery p{line-height:1.5;font-size:12px;color:var(--text-muted)}
      .v21-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.v21-grid[hidden],[hidden]#v21AllLabel{display:none!important}.v21-panel label{display:block;font-size:12px;margin:8px 0}.v21-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.v21-actions button{white-space:normal;height:auto;min-height:36px}.v21-order{display:inline-flex;gap:3px;flex-shrink:0}.v21-order button{padding:2px 8px;min-width:28px;min-height:30px}.task-meta{flex-wrap:wrap!important;gap:6px}.task-info{min-width:0}.task-title-text{overflow-wrap:anywhere}.task-actions{flex-shrink:0}
      #v17WorkloadSettings{display:none!important}#v21BandPreview{font-size:11px;line-height:1.6;white-space:pre-line;margin-top:10px}.v21-recovery{width:min(760px,calc(100vw - 24px));max-height:90dvh;overflow:auto}.v21-choice{display:grid;gap:10px;margin:14px 0}.v21-choice button{display:block;width:100%;text-align:left;padding:12px 14px;height:auto;white-space:normal}.v21-choice button small{display:block;margin-top:4px;font-size:11px;line-height:1.5;color:var(--text-muted);font-weight:400}.v21-choice button[aria-checked=true]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}.v21-differences-wrap{margin-top:14px}.v21-differences-wrap h3{font-size:13px;margin:0 0 8px}#v21RecoveryBlocked[data-error=true]{color:var(--red)}.v21-differences{overflow-wrap:anywhere;overflow:auto}.v21-differences .sync-conflict-grid{grid-template-columns:1fr}.v21-differences select{max-width:100%}#v21Help{margin:10px 0;padding:10px 14px;border:1px solid var(--border);border-radius:10px;font-size:12px}#v21Message[data-error=true]{color:var(--red)}
      @media(max-width:600px){.v21-grid{grid-template-columns:1fr}.task-item{flex-wrap:wrap}.task-actions{margin-left:auto}.modal{max-width:calc(100vw - 24px)!important}.v21-order button{min-height:36px;min-width:32px}}`;
    root.document.head.appendChild(style);
    const help=root.document.createElement('section');help.id='v21Help';help.innerHTML='<strong>StudyQuest v21</strong> · Your account and this device<div class="v21-actions"><button class="btn btn-ghost" id="v21Check">Check sync / recover</button><button class="btn btn-ghost" id="v21Export">Export saved copies</button><button class="btn btn-ghost" id="v21Retry">Retry device storage</button></div><p id="v21Message" role="status">Opening this version does not approve a merge. Check sync if tasks appear missing.</p>';
    const tabs=root.document.querySelector('.tabs');if(tabs)tabs.before(help);else root.document.body.prepend(help);
    byId('v21Check').onclick=async()=>{try{if(core.getPreview())showRecovery();else await core.compare();}catch(e){note(e.message,true);}};
    byId('v21Export').onclick=async()=>{try{const backup=await core.snapshots({allowPartial:true});core.download(backup);note(backup.errors.length?'Partial backup downloaded: some storage could not be read. Details are included; keep earlier backups too.':'Download requested; check your Downloads folder.',!!backup.errors.length);}catch(e){note(e.message,true);}};
    byId('v21Retry').onclick=async()=>{try{await core.retry();unblockEditing();note('Device recovery opened. Review sync status before editing.');}catch(e){note(e.message,true);}};
    for(const name of ['renderAll','renderBins','renderUnscheduled','openProfileSettings']){
      const original=root[name];if(typeof original!=='function')continue;
      root[name]=function(...args){const result=original.apply(this,args);enhance();if(name==='openProfileSettings')fillWorkload();return result;};
    }
    const originalConflict=root.openLiveSyncConflict;
    root.openLiveSyncConflict=function(...args){const result=originalConflict.apply(this,args);if(core.getPreview())showRecovery();return result;};
    const originalCompare=root.compareChromeAndLive;
    root.compareChromeAndLive=async function(...args){await core.refreshConnection();const result=await originalCompare.apply(this,args);if(core.getPreview()?.smartMerge?.different)showRecovery();return result;};
    const originalRefresh=root.refreshSmartMergePreview;
    root.refreshSmartMergePreview=function(...args){const result=originalRefresh.apply(this,args);if(byId('v21RecoveryModal')?.classList.contains('open'))showRecovery(false);return result;};
    root.document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!busy)root.closeModal?.('v21RecoveryModal');});
    if(ui.manualSort)core.setManualSort();
    enhance();
  }
  const api={install,enhance,blockEditing,validateWorkload,reorder,bandPreview,DEFAULT_BANDS};
  root.StudyQuestV21=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
