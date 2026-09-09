/* v21 only. Storage-agnostic course collection: no cloud requests here, no weekly mutations.
   Persistence goes through an injected store. Without one this uses an independent
   IndexedDB collection. Hosted builds inject an account-state store instead. */
(function(root) {
  'use strict';
  const DB='studyquest-v21-manual', VERSION=1;
  const DEFAULT_COLUMNS=['Attend class','Watch clip','Read','Summarize','Practice','Memorize','Exam ready'];
  const copy=v=>JSON.parse(JSON.stringify(v));
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const active=items=>items.filter(x=>!x.archived);
  const uid=()=>root.crypto.randomUUID();
  const blank=key=>({key,version:VERSION,revision:0,courses:[],settings:{subjectEnabled:false,view:'week'}});
  function completion(course) {
    const columns=active(course.columns), rows=active(course.rows);
    return {total:rows.length,done:columns.length?rows.filter(r=>columns.every(c=>r.checks[c.id]===true)).length:0,columns:columns.length};
  }
  function move(items,id,direction) {
    const visible=active(items), at=visible.findIndex(x=>x.id===id), other=visible[at+direction];
    if(![-1,1].includes(direction)||at<0||!other)return false;
    const from=items.findIndex(x=>x.id===id),to=items.findIndex(x=>x.id===other.id);
    [items[from],items[to]]=[items[to],items[from]];return true;
  }
  function validate(value) {
    if(!value||value.version!==VERSION||typeof value.key!=='string'||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.courses)||!value.settings||typeof value.settings.subjectEnabled!=='boolean'||!['week','subject','manual'].includes(value.settings.view))throw Error('Unrecognized manual-course data. Export and retry; nothing was replaced.');
    const ids=new Set();
    const item=x=>{if(!x||typeof x.id!=='string'||ids.has(x.id)||typeof x.name!=='string'||!x.name.trim())throw Error('Invalid or duplicate manual-course record.');ids.add(x.id);};
    for(const c of value.courses){item(c);if(!Array.isArray(c.rows)||!Array.isArray(c.columns))throw Error('Invalid course table.');c.columns.forEach(item);c.rows.forEach(r=>{item(r);if(!r.checks||typeof r.checks!=='object'||Array.isArray(r.checks))throw Error('Invalid lecture checkmarks.');});}
    return value;
  }
  // An injected store owns durability. This layer never performs its own network calls.
  const store=()=>root.StudyQuestV21ManualStore||null;
  const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  function openDb(){return new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>fail(Error('Manual-course storage did not respond. Close other tabs and retry.')),8000);
    const fail=e=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}};
    let req;try{req=root.indexedDB.open(DB,1);}catch(e){fail(e);return;}
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('workspaces'))db.createObjectStore('workspaces',{keyPath:'key'});if(!db.objectStoreNames.contains('history'))db.createObjectStore('history',{autoIncrement:true});};
    req.onerror=()=>fail(req.error);req.onblocked=()=>fail(Error('Manual storage is blocked by another tab. Close it and retry.'));
    req.onsuccess=()=>{if(settled){req.result.close();return;}settled=true;clearTimeout(timer);req.result.onversionchange=()=>req.result.close();resolve(req.result);};
  });}
  async function readRecord(key){
    const injected=store();
    if(injected)return validate(await injected.read(key)||blank(key));
    const db=await openDb();try{return validate(await request(db.transaction('workspaces','readonly').objectStore('workspaces').get(key))||blank(key));}finally{db.close();}}
  // Compare-and-swap and exact prior-copy archive are one atomic transaction.
  async function writeRecord(expected,next){
    validate(next);
    const injected=store();
    // The store must reject when the stored copy no longer equals `expected`.
    if(injected)return validate(await injected.write(expected,next));
    const db=await openDb();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(['workspaces','history'],'readwrite'),store=tx.objectStore('workspaces');let reason;
        tx.oncomplete=resolve;tx.onabort=()=>reject(reason||tx.error||Error('Manual-course save failed.'));tx.onerror=()=>{};
        const get=store.get(expected.key);
        get.onsuccess=()=>{try{
          const current=get.result||blank(expected.key);
          if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('Another tab changed these courses. Reload saved courses before editing; your earlier data was kept.');
          tx.objectStore('history').add({key:expected.key,capturedAt:new Date().toISOString(),record:copy(current)});
          store.put(next);
        }catch(e){reason=e;tx.abort();}};
      });
      const verified=await request(db.transaction('workspaces','readonly').objectStore('workspaces').get(next.key));
      if(JSON.stringify(verified)!==JSON.stringify(next))throw Error('Save readback changed. Reload saved courses to verify the latest copy.');
      return verified;
    }finally{db.close();}
  }
  let core,record,key,selected='',columnsOpen=false,trashOpen=false,queue=Promise.resolve(),pending=0,ready=false,error='',channel,installed=false,rendering=false;
  const el=id=>root.document?.getElementById(id);
  const current=()=>record?.courses.find(c=>c.id===selected&&!c.archived);
  function save(mutator){
    pending++;render();
    const run=async()=>{
      if(!ready||error)throw Error(error||'Manual storage is not ready.');
      if(core.getStatus().storageError)throw Error('Resolve device recovery before editing.');
      const expected=copy(record),next=copy(record);
      if(mutator(next)===false)return false;
      next.revision++;next.savedAt=new Date().toISOString();
      record=await writeRecord(expected,next);
      channel?.postMessage({key,revision:record.revision});
      return true;
    };
    const result=queue.then(run);queue=result.catch(()=>{});
    return result.catch(e=>{error=e.message;throw e;}).finally(()=>{pending--;render();});
  }
  function act(fn){return Promise.resolve().then(fn).catch(e=>{error=e.message;render();return false;});}
  async function reload(){if(pending)return;try{record=await readRecord(key);ready=true;error='';applyView();}catch(e){ready=false;error=e.message;}render();}
  function button(action,label,extra='',disabled=false){return `<button type="button" class="btn btn-ghost btn-sm" data-mc-action="${action}" ${extra} ${disabled?'disabled':''}>${label}</button>`;}
  function orders(items,item,kind){const list=active(items),i=list.findIndex(x=>x.id===item.id),attrs=`data-id="${esc(item.id)}" data-kind="${kind}"`;return `<span class="mc-orders">${button('move','↑',`${attrs} data-direction="-1" aria-label="Move ${kind} up"`,i===0)}${button('move','↓',`${attrs} data-direction="1" aria-label="Move ${kind} down"`,i===list.length-1)}</span>`;}
  function renderCourses(){const courses=active(record.courses);return `<div class="mc-heading"><div><h2>Manual courses</h2><p>Your lectures, your checklists. No calendar or semester needed.</p></div>${button('add-course','+ Add course')}</div>${courses.length?courses.map(c=>{const p=completion(c);return `<div class="mc-course" data-course="${esc(c.id)}">${orders(record.courses,c,'course')}<strong>${esc(c.name)}</strong><span>${p.columns?`${p.done} / ${p.total} lectures complete`:'Set up columns'}</span>${button('open','Open',`data-id="${esc(c.id)}"`)}${button('rename','Rename',`data-kind="course" data-id="${esc(c.id)}"`)}${button('archive','To trash',`data-kind="course" data-id="${esc(c.id)}"`)}</div>`;}).join(''):'<div class="mc-empty">Start with a course, such as IDT 4. Then add your lectures or topics.</div>'}`;}
  function renderCourse(c){const p=completion(c),cols=active(c.columns),rows=active(c.rows);return `${button('back','← All courses')}<div class="mc-heading"><h2>${esc(c.name)}</h2>${button('rename','Rename course',`data-kind="course" data-id="${esc(c.id)}"`)}</div><div class="mc-actions">${button('add-row','+ Lecture/topic')}${button('bulk','+ Several lectures')}${button('columns',columnsOpen?'Close column settings':'Customize columns')}<label><input type="checkbox" data-mc-change="dates" ${c.showDates?'checked':''}> Show optional dates</label></div><p>${p.columns?`${p.done} / ${p.total} lectures complete`:'Set up columns to track completion.'}</p>${columnsOpen?renderColumns(c):''}<div class="mc-scroll" tabindex="0" role="region" aria-label="${esc(c.name)} lecture checklist"><table class="mc-table"><thead><tr><th>Lecture / topic</th>${c.showDates?'<th>Optional date</th>':''}${cols.map(col=>`<th>${esc(col.name)}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${rows.map(r=>`<tr data-row="${esc(r.id)}"><th scope="row">${orders(c.rows,r,'row')}${button('rename',esc(r.name),`data-kind="row" data-id="${esc(r.id)}"`)}</th>${c.showDates?`<td><input type="date" data-mc-change="date" data-id="${esc(r.id)}" value="${esc(r.date||'')}" aria-label="Date for ${esc(r.name)}"></td>`:''}${cols.map(col=>`<td><input type="checkbox" data-mc-change="check" data-id="${esc(r.id)}" data-column="${esc(col.id)}" aria-label="${esc(r.name)} — ${esc(col.name)}" ${r.checks[col.id]===true?'checked':''}></td>`).join('')}<td>${button('archive','To trash',`data-kind="row" data-id="${esc(r.id)}"`)}</td></tr>`).join('')}</tbody></table></div>${rows.length?'':'<p>No lectures yet. Add a named topic or create several numbered lectures.</p>'}`;}
  function renderColumns(c){return `<section class="mc-columns" aria-label="Customize columns"><h3>Columns · ${esc(c.name)}</h3><p>Changes apply only to this course. New columns start unchecked and recalculate completion.</p>${active(c.columns).map(col=>`<div class="mc-course">${orders(c.columns,col,'column')}<span>${esc(col.name)}</span>${button('rename','Rename',`data-kind="column" data-id="${esc(col.id)}"`)}${button('archive','To trash',`data-kind="column" data-id="${esc(col.id)}"`)}</div>`).join('')}${button('add-column','+ Add column')}</section>`;}
  function renderTrash(){let items=[];for(const c of record.courses){if(c.archived)items.push({kind:'course',id:c.id,course:c.id,name:c.name});else for(const kind of ['row','column'])for(const x of c[kind==='row'?'rows':'columns'].filter(x=>x.archived))items.push({kind,id:x.id,course:c.id,name:`${c.name} · ${x.name}`});}return `<section class="mc-columns"><h3>Trash / Restore</h3><p>Nothing here is permanently deleted. Restoring a course restores its lecture table; previously trashed rows and columns remain in trash.</p>${items.map(x=>`<div class="mc-course"><span>${esc(x.name)} (${x.kind})</span>${button('restore','Restore',`data-kind="${x.kind}" data-id="${esc(x.id)}" data-course="${esc(x.course)}"`)}</div>`).join('')||'<p>Trash is empty.</p>'}</section>`;}
  function settings(){
    const host=el('profileTrashBtn')?.parentElement;if(!host)return;
    let panel=el('v21TrackerSettings');if(!panel){panel=root.document.createElement('section');panel.id='v21TrackerSettings';panel.className='v21-panel';host.after(panel);}
    panel.innerHTML=`<h3>Study tracker</h3><label><input id="v21EnableSubject" type="checkbox" data-mc-change="subject" ${record?.settings.subjectEnabled?'checked':''} ${!ready||pending||error?'disabled':''}> Enable “By subject · from weeks”</label><p>Show subjects generated from existing weekly records. Turning this off hides the option without deleting anything. ${store()?'Saved to your account.':'Saved on this laptop only.'}</p>`;
  }
  function render(){
    if(!installed||rendering)return;rendering=true;
    try{
      settings();const tab=el('tab-weekly');if(!tab)return;
      let host=el('v21ManualRoot');if(!host){host=root.document.createElement('section');host.id='v21ManualRoot';tab.prepend(host);}
      const view=record?.settings.view||'week',enabled=record?.settings.subjectEnabled===true;
      root.document.body.classList.toggle('mc-subject-enabled',enabled);
      tab.classList.toggle('mc-manual',view==='manual');
      const nav=root.document.querySelector('[aria-controls="tab-weekly"]');if(nav)nav.textContent='Study tracker';
      const disabled=!ready||pending>0||!!error;
      host.innerHTML=`<h2 class="mc-title">Study tracker</h2><div class="mc-actions" role="group" aria-label="Tracker views">${button('view','By week',`data-view="week" aria-pressed="${view==='week'}"`,disabled)}${enabled?button('view','By subject · from weeks',`data-view="subject" aria-pressed="${view==='subject'}"`,disabled):''}${button('view','Manual courses',`data-view="manual" aria-pressed="${view==='manual'}"`,disabled)}</div><div class="mc-status" role="status" ${error?'data-error="true"':''}>${error?esc(error):!ready?'Opening local course storage…':pending?'Saving on this laptop…':store()?.statusText?.({ready,pending,record})??(record.revision?'Saved on this laptop · manual courses are not cloud-synced.':'Manual courses stay on this laptop. Export a backup regularly.')}</div><div class="mc-actions">${button('reload','Reload saved courses','',!!pending)}${button('export','Export courses','',!record)}</div>${view==='manual'&&record?`<fieldset class="mc-fieldset" ${disabled?'disabled':''}>${current()?renderCourse(current()):renderCourses()}<div class="mc-actions">${button('trash',trashOpen?'Close trash':'Trash / Restore')}</div>${trashOpen?renderTrash():''}</fieldset>`:''}`;
      if(!enabled){el('weeklyTrackerTable')?.classList.remove('v20-weekly-subject-mode');const old=el('v20WeeklySubjectTracking');if(old)old.hidden=true;const surface=el('v20WeeklyOriginalSurface');if(surface){surface.hidden=false;surface.inert=false;surface.removeAttribute('aria-hidden');}}
    }finally{rendering=false;}
  }
  function applyView(){if(!record)return;const view=record.settings.subjectEnabled?record.settings.view:record.settings.view==='subject'?'week':record.settings.view;
    if(view==='week')root.StudyQuestV20?.setWeeklyViewMode('week');
    else if(view==='subject')root.StudyQuestV20?.setWeeklyViewMode('subject');
  }
  function dialog(title,fields,submit){
    let modal=el('v21CourseDialog');if(!modal){modal=root.document.createElement('div');modal.id='v21CourseDialog';modal.className='modal-overlay';root.document.body.appendChild(modal);}
    modal.innerHTML=`<div class="modal mc-dialog" role="dialog" aria-modal="true" aria-labelledby="mcDialogTitle"><h2 id="mcDialogTitle">${esc(title)}</h2><form id="mcForm">${fields}<p id="mcFormError" role="alert"></p><div class="mc-actions"><button type="button" class="btn btn-ghost" id="mcCancel">Cancel</button><button type="submit" class="btn btn-primary" id="mcSubmit">Save</button></div></form></div>`;
    el('mcCancel').onclick=()=>root.closeModal('v21CourseDialog');
    el('mcForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;const data=new root.FormData(form);el('mcSubmit').disabled=true;el('mcCancel').disabled=true;try{await submit(data);root.closeModal('v21CourseDialog');}catch(e){el('mcFormError').textContent=e.message;}finally{el('mcSubmit').disabled=false;el('mcCancel').disabled=false;}};
    root.openModal('v21CourseDialog');modal.querySelector('input')?.focus();
  }
  const nameField=(value='')=>`<label>Name<input name="name" required maxlength="160" value="${esc(value)}" autocomplete="off"></label>`;
  const nameFrom=data=>{const name=String(data.get('name')||'').trim();if(!name)throw Error('Enter a name.');return name;};
  function collection(next,kind,courseId=selected){if(kind==='course')return next.courses;const c=next.courses.find(x=>x.id===courseId);if(!c||c.archived)throw Error('This course is no longer available.');return kind==='row'?c.rows:c.columns;}
  async function handleClick(event){
    const target=event.target.closest('[data-mc-action]');if(!target)return;const action=target.dataset.mcAction,{id,kind}=target.dataset;
    if(action==='reload')return reload();
    if(action==='export')return core.download({format:'studyquest-v21-manual-courses',version:VERSION,capturedAt:new Date().toISOString(),manualCourses:copy(record)});
    if(!ready||pending||error)return;
    if(action==='view'){const view=target.dataset.view;if(view==='subject'&&!record.settings.subjectEnabled)return;await save(n=>{n.settings.view=view;});applyView();render();return;}
    if(action==='open'){selected=id;columnsOpen=false;trashOpen=false;render();return;}
    if(action==='back'){selected='';columnsOpen=false;render();return;}
    if(action==='columns'){columnsOpen=!columnsOpen;render();return;}
    if(action==='trash'){trashOpen=!trashOpen;render();return;}
    if(action==='add-course')return dialog('Add course',nameField(),async data=>{const name=nameFrom(data),newId=uid();await save(n=>{n.courses.push({id:newId,name,showDates:false,columns:DEFAULT_COLUMNS.map(name=>({id:uid(),name})),rows:[]});});selected=newId;render();});
    if(action==='add-row'||action==='add-column'){const courseId=selected;return dialog(action==='add-row'?'Add lecture / topic':'Add column',nameField()+(action==='add-column'?'<p>This adds unchecked cells and recalculates completion. Existing checkmarks stay unchanged.</p>':''),data=>{const name=nameFrom(data);return save(n=>collection(n,action==='add-row'?'row':'column',courseId).push({id:uid(),name,...(action==='add-row'?{checks:{},date:''}:{})}));});}
    if(action==='bulk'){const courseId=selected;return dialog('Add several lectures',`<label>Prefix<input name="prefix" required maxlength="120" value="Lecture"></label><label>Start at<input name="start" type="number" min="1" max="99999" value="${(current()?.rows.length||0)+1}" required></label><label>How many?<input name="count" type="number" min="1" max="200" value="10" required></label>`,data=>{const prefix=String(data.get('prefix')).trim(),start=Number(data.get('start')),count=Number(data.get('count'));if(!prefix||!Number.isInteger(start)||start<1||start>99999||!Number.isInteger(count)||count<1||count>200)throw Error('Enter a prefix, a start number, and 1–200 lectures.');return save(n=>{const rows=collection(n,'row',courseId);for(let i=0;i<count;i++)rows.push({id:uid(),name:`${prefix} ${start+i}`,checks:{},date:''});});});}
    if(action==='rename'){const courseId=selected,item=collection(record,kind,courseId).find(x=>x.id===id);if(!item)return;return dialog('Rename '+kind,nameField(item.name),data=>{const name=nameFrom(data);return save(n=>{collection(n,kind,courseId).find(x=>x.id===id).name=name;});});}
    if(action==='move')return save(n=>move(collection(n,kind),id,Number(target.dataset.direction)));
    if(action==='archive'){if(!root.confirm(`Move this ${kind} to recoverable trash? Its saved checkmarks will be kept.`))return;return save(n=>{collection(n,kind).find(x=>x.id===id).archived=true;});}
    if(action==='restore')return save(n=>{collection(n,kind,target.dataset.course).find(x=>x.id===id).archived=false;});
  }
  async function handleChange(event){const target=event.target,action=target.dataset.mcChange;if(!action)return;
    if(action==='subject'){const value=target.checked;await save(n=>{n.settings.subjectEnabled=value;if(!value&&n.settings.view==='subject')n.settings.view='week';});applyView();render();return;}
    const courseId=selected;
    if(action==='dates'){const checked=target.checked;return save(n=>{n.courses.find(c=>c.id===courseId).showDates=checked;});}
    const {id,column}=target.dataset,value=action==='check'?target.checked:target.value;
    return save(n=>{const row=collection(n,'row',courseId).find(r=>r.id===id);if(action==='check')row.checks[column]=value;else if(action==='date')row.date=value;});
  }
  async function snapshot(){const stored=await readRecord(key);return {format:'studyquest-v21-manual-courses',version:VERSION,manualCourses:stored};}
  function install(bridge){if(installed)return;installed=true;core=bridge;key=core.storageKey()+':'+core.accountKey();record=blank(key);
    const style=root.document.createElement('style');style.textContent=`
      #v20WeeklyToolbarControls{display:none!important}body:not(.mc-subject-enabled) [data-v20-weekly-action="open-stage-manager"],body:not(.mc-subject-enabled) [data-v20-weekly-action="open-subject-setup"]{display:none!important}
      #tab-weekly.mc-manual>:not(#v21ManualRoot){display:none!important}#v21ManualRoot{min-width:0;max-width:100%;margin-bottom:18px}#v21ManualRoot h2{font-size:20px;margin:12px 0}#v21ManualRoot p,#v21TrackerSettings p{font-size:12px;color:var(--text-muted);line-height:1.6}.mc-title{font-size:14px!important;color:var(--text-muted)}
      .mc-actions,.mc-heading,.mc-course{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0}.mc-heading{justify-content:space-between}.mc-actions [aria-pressed=true]{background:var(--accent);color:var(--bg);border-color:var(--accent)}.mc-course,.mc-columns,.mc-empty{border:1px solid var(--border);padding:14px;border-radius:12px}.mc-course strong,.mc-course>span:not(.mc-orders){flex:1;min-width:100px;overflow-wrap:anywhere}.mc-course span{font-size:12px}.mc-columns{margin:14px 0}.mc-orders{display:inline-flex;gap:3px}.mc-orders button{min-width:32px;min-height:34px}
      .mc-scroll{overflow:auto;max-width:100%;border:1px solid var(--border);border-radius:12px}.mc-table{border-collapse:collapse;min-width:800px;width:100%;font-size:12px}.mc-table td,.mc-table th{padding:12px;border-bottom:1px solid var(--border);text-align:center;min-width:90px}.mc-table th:first-child{min-width:245px;max-width:320px;text-align:left;position:sticky;left:0;background:var(--surface,#19151f);z-index:1}.mc-table th:first-child button{white-space:normal;overflow-wrap:anywhere}.mc-table input[type=checkbox]{width:22px;height:22px;cursor:pointer;accent-color:var(--accent)}.mc-fieldset{border:0;margin:0;padding:0;min-width:0}.mc-status{font-size:12px;margin-top:10px;color:var(--text-muted)}.mc-status[data-error=true],#mcFormError{color:var(--red,#f76a6a)}.mc-dialog{width:min(520px,calc(100vw - 24px));max-height:85dvh;overflow:auto}.mc-dialog label{display:block;margin:14px 0}.mc-dialog input{display:block;width:100%;margin-top:6px}.mc-actions button{white-space:normal;min-height:36px}.mc-table button{height:auto}#v21TrackerSettings input{accent-color:var(--accent)}
      @media(max-width:600px){.mc-table th:first-child{min-width:180px;max-width:200px}.mc-course{gap:8px;padding:10px}.mc-heading{align-items:flex-start}.mc-actions{gap:8px}}
    `;root.document.head.appendChild(style);
    root.document.addEventListener('click',event=>{if(event.target.closest('[data-mc-action]'))void act(()=>handleClick(event));});
    root.document.addEventListener('change',event=>{if(event.target.dataset.mcChange)void act(()=>handleChange(event));});
    for(const name of ['renderAll','renderWeekly','switchTab','openProfileSettings','studyQuestV20AfterRender']){const original=root[name];if(typeof original==='function')root[name]=function(...args){const result=original.apply(this,args);render();return result;};}
    if(store()?.watch)store().watch(()=>{if(!pending)void reload();});
    else try{channel=new root.BroadcastChannel('studyquest-v21-manual');channel.onmessage=event=>{if(event.data.key===key&&event.data.revision>record.revision&&!pending){error='Another tab saved newer courses. Reload saved courses before editing.';render();}};}catch{}
    render();void reload();
  }
  const api={install,snapshot,reload,completion,move,validate,blank,DEFAULT_COLUMNS,VERSION,DB,getRecord:()=>copy(record),whenIdle:()=>queue};
  root.StudyQuestV21Manual=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
