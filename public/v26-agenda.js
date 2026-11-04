(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.StudyQuestV26Agenda=api;})(typeof window==='undefined'?globalThis:window,function(){
 'use strict';
 const DAY=86400000,PAGE=60,ITEMS=50;
 function ms(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return NaN;const x=Date.parse(s+'T12:00:00Z');return Number.isFinite(x)&&new Date(x).toISOString().slice(0,10)===s?x:NaN;}
 function key(x){return new Date(x).toISOString().slice(0,10);}
 function overdue(t,today){return !!t&&!t.done&&Number.isFinite(ms(t.date))&&t.date<today;}
 function bounds(tasks,today,p){const now=ms(today);if(!Number.isFinite(now))throw Error('Invalid logical date');if(p.mode==='range'){const a=ms(p.start),b=ms(p.end);if(!Number.isFinite(a)||!Number.isFinite(b)||a>b)throw Error('Choose valid dates in order');return[a,b];}let back=p.past;if(back==='all')back=tasks.reduce((n,t)=>t&&Number.isFinite(ms(t.date))?Math.max(n,Math.round((now-ms(t.date))/DAY)):n,0);return[Math.max(ms('0001-01-01'),now-Number(back)*DAY),Math.min(ms('9999-12-31'),now+Number(p.days)*DAY)];}
 function defaults(){return{mode:'days',days:30,past:0,start:'',end:''};}
 function validate(value){const p={...defaults(),...value};if(!['days','range','all'].includes(p.mode))return defaults();if(!Number.isSafeInteger(p.days)||p.days<1||p.days>3652058)return defaults();if(![0,1,2,7,30,90,'all'].includes(p.past))return defaults();if(p.mode==='range'&&(!Number.isFinite(ms(p.start))||!Number.isFinite(ms(p.end))||p.start>p.end))return defaults();return p;}
 function future(tasks,today,past=0){const lower=past==='all'?-Infinity:ms(today)-Number(past)*DAY;return tasks.filter(t=>t&&Number.isFinite(ms(t.date))&&(ms(t.date)>=lower||(Number.isFinite(ms(t.endDate))&&t.endDate>=today))).slice().sort((a,b)=>a.date.localeCompare(b.date)||String(a.id).localeCompare(String(b.id)));}
 let core,prefs=defaults(),account='',offset=null,allLimit=ITEMS,sideLimit=ITEMS,storageError='',earlierDragId=null;
 let toolbar=null,uiMode='days',lastDaysMode='days',draft={days:'30',start:'',end:''};
 function syncAccount(){if(!core)return;const next=String(core.accountKey()||'');if(next===account)return;account=next;offset=null;allLimit=sideLimit=ITEMS;try{prefs=validate(JSON.parse(localStorage.getItem('studyquest:v26:agenda:'+encodeURIComponent(account))||'null'));storageError='';}catch{prefs=defaults();storageError='View preference could not be read. Task saves are unaffected.';}uiMode=prefs.mode==='range'?'range':'days';lastDaysMode=prefs.mode==='all'?'all':'days';draft={days:String(prefs.days),start:prefs.start,end:prefs.end};}
 function persist(){try{localStorage.setItem('studyquest:v26:agenda:'+encodeURIComponent(account),JSON.stringify(prefs));storageError='';}catch{storageError='View applies for this session; this device could not store the preference.';}}
 function change(p){syncAccount();prefs=validate({...prefs,...p});offset=null;allLimit=sideLimit=ITEMS;persist();core.render();}
 function getDays(tasks,today){syncAccount();if(prefs.mode==='all')return[];const[a,b]=bounds(tasks,today,prefs),total=Math.floor((b-a)/DAY)+1;if(offset===null)offset=prefs.mode==='range'?0:Math.max(0,Math.floor((ms(today)-a)/DAY)-Math.floor(PAGE/2));offset=Math.max(0,Math.min(offset,Math.max(0,total-1)));const result=[];for(let i=offset;i<Math.min(total,offset+PAGE);i++)result.push(key(a+i*DAY));return result;}
 function el(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;}
 function button(text,fn){const b=el('button',text,'view-mode-btn');b.type='button';b.addEventListener('click',fn);return b;}
 function input(type,label,value){const w=el('label',label),i=el('input');i.type=type;i.value=value;i.setAttribute('aria-label',label);w.appendChild(i);return[w,i];}
 function finishEarlierDrag(){earlierDragId=null;core.endDrag();document.querySelectorAll('.v26-earlier-task.dragging,.date-bin.drag-over,.task-item.drag-target').forEach(node=>node.classList.remove('dragging','drag-over','drag-target'));}
 function earlierTask(task){
  const title=String(task.title||'Untitled task'),row=el('div',undefined,'v26-earlier-task');
  row.dataset.taskId=task.id;row.draggable=true;
  const heading=el('div',undefined,'v26-earlier-heading'),handle=el('span','⠿','v26-earlier-drag');
  handle.title='Drag onto a day to reschedule';handle.setAttribute('aria-hidden','true');
  const name=button(title,()=>core.edit(task.id));name.classList.add('v26-task-link');name.title='Edit task; original date '+task.date;
  heading.append(handle,name);row.appendChild(heading);
  if(task.recurrence&&task.recurrence!=='none'||task._studyquestV16Series)row.appendChild(el('small','Repeats · saved occurrence'));
  const actions=el('div',undefined,'v26-earlier-actions');
  for(const[text,label,action]of[['✏️','Edit task',()=>core.edit(task.id)],['📅 Assign','Assign date',()=>core.assign(task.id)],['✕','Delete task',()=>core.remove(task.id)]]){
   const control=button(text,action);control.title=label;control.setAttribute('aria-label',label+': '+title);
   control.classList.add('v26-earlier-action');if(label==='Delete task')control.classList.add('v26-earlier-delete');
   actions.appendChild(control);
  }
  row.appendChild(actions);
  row.addEventListener('dragstart',event=>{if(event.target.closest('input,textarea')){event.preventDefault();return;}earlierDragId=task.id;core.startDrag(task.id,event);row.classList.add('dragging');});
  row.addEventListener('dragend',finishEarlierDrag);
  return row;
 }
 function dropEarlierTask(event){
  if(!earlierDragId)return;
  const bin=event.target.closest('.date-bin[data-date]');if(!bin)return;
  event.preventDefault();event.stopImmediatePropagation();
  const id=earlierDragId,date=bin.dataset.date;finishEarlierDrag();core.move(id,date);
 }
 function renderList(box,tasks,limit,more,empty,earlier=false){box.replaceChildren();if(!tasks.length){box.appendChild(el('p',empty));return;}let date='';for(const task of tasks.slice(0,limit)){if(date!==task.date){date=task.date;box.appendChild(el('h4',date));}if(earlier){box.appendChild(earlierTask(task));continue;}const b=button(String(task.title||'Untitled task'),()=>core.edit(task.id));b.classList.add('v26-task-link');b.title='Edit task; original date '+task.date;box.appendChild(b);if(task.recurrence&&task.recurrence!=='none')box.appendChild(el('small','Repeats · saved occurrence'));}if(limit<tasks.length)box.appendChild(button('Show 50 more ('+(tasks.length-limit)+' remaining)',more));}
 function formatDate(value){return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(ms(value)));}
 function clearInvalid(control){control.setCustomValidity('');control.removeAttribute('aria-invalid');if(toolbar)toolbar.error.textContent='';}
 function invalid(control,message){control.setCustomValidity(message);control.setAttribute('aria-invalid','true');toolbar.error.textContent=message;control.reportValidity();}
 function setSummary(period,count){toolbar.period.textContent=period;toolbar.count.textContent=count;}
 function renderToolbar(){
  if(!toolbar)return;
  const t=toolbar,range=uiMode==='range',saved=prefs.mode==='all';
  t.days.hidden=range;t.range.hidden=!range;
  for(const b of t.modes.children){const active=b.dataset.mode===uiMode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
  t.future.disabled=saved;t.customInput.disabled=saved;t.applyDays.disabled=saved;
  t.saved.value=saved?'all':'days';t.past.value=String(prefs.past);
  for(const b of t.presets.children){const active=prefs.mode==='days'&&Number(b.dataset.days)===prefs.days;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
  for(const[control,value]of[[t.customInput,draft.days],[t.start,draft.start],[t.end,draft.end]]){if(document.activeElement!==control)control.value=value;}
  t.hint.textContent=range?'Choose dates, then Apply range. The summary and tasks show the applied filter.':saved?'Showing saved tasks as a separate list. Choose Date window to use future-day controls.':'';
  t.notice.textContent=storageError;
 }
 function mount(){
  if(document.getElementById('v26AgendaControls'))return;
  const old=document.getElementById('viewModeRow');if(!old)return;
  const host=old.parentElement;host.replaceChildren();host.removeAttribute('style');host.id='v26AgendaControls';host.classList.add('v26-controls');host.setAttribute('aria-label','Agenda date filters');
  document.getElementById('binsContainer').addEventListener('drop',dropEarlierTask,true);
  const header=el('div',undefined,'v26-toolbar-header'),modes=el('div',undefined,'v26-segments');
  modes.setAttribute('role','group');modes.setAttribute('aria-label','Date filter mode');
  for(const[label,mode]of[['Days ahead','days'],['Date range','range']]){
   const b=button(label,()=>{
    if(uiMode===mode)return;uiMode=mode;toolbar.error.textContent='';
    if(mode==='range'){
     const[a,z]=bounds(core.getState().tasks||[],core.today(),{...prefs,mode:'days'});
     if(!draft.start)draft.start=prefs.start||key(a);if(!draft.end)draft.end=prefs.end||key(z);
     renderToolbar();
    }else if(prefs.mode!==lastDaysMode){change({mode:lastDaysMode});}else renderToolbar();
   });b.setAttribute('aria-label',label);b.dataset.mode=mode;b.setAttribute('aria-controls',mode==='range'?'v26RangeControls':'v26DaysControls');modes.appendChild(b);
  }
  const info=el('div',undefined,'v26-summary');info.id='v26AgendaInfo';info.setAttribute('role','status');info.setAttribute('aria-live','polite');
  const period=el('strong'),count=el('span');info.append(period,count);header.append(modes,info);host.appendChild(header);
  const days=el('div',undefined,'v26-toolbar-row');days.id='v26DaysControls';
  const futureGroup=el('fieldset',undefined,'v26-control-group');futureGroup.appendChild(el('legend','Future days'));
  const presets=el('div',undefined,'v26-segments v26-presets');
  for(const n of[30,90,180,365]){const b=button(n+'d',()=>{draft.days=String(n);clearInvalid(toolbar.customInput);change({mode:'days',days:n});});b.setAttribute('aria-label',n+'d');b.dataset.days=String(n);presets.appendChild(b);}futureGroup.appendChild(presets);
  const custom=el('div',undefined,'v26-control-group'),[customLabel,customInput]=input('number','Custom days ahead',draft.days);customInput.min='1';customInput.max='3652058';customInput.step='1';customInput.inputMode='numeric';customInput.id='v26CustomDays';customLabel.htmlFor=customInput.id;
  const customActions=el('div',undefined,'v26-input-actions');customLabel.removeChild(customInput);customActions.appendChild(customInput);custom.append(customLabel,customActions);
  const applyCustom=()=>{const n=Number(customInput.value);if(customInput.value.trim()===''||!Number.isSafeInteger(n)||n<1||n>3652058){invalid(customInput,'Enter a positive whole number from 1 to 3,652,058.');return;}clearInvalid(customInput);draft.days=String(n);change({mode:'days',days:n});};
  const applyDays=button('Apply',applyCustom);applyDays.setAttribute('aria-label','Apply custom days');customActions.appendChild(applyDays);
  customInput.addEventListener('input',()=>{draft.days=customInput.value;clearInvalid(customInput);});customInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();applyCustom();}});
  function select(label,options){const wrap=el('label',undefined,'v26-control-group'),text=el('span',label),control=el('select');control.setAttribute('aria-label',label);for(const[value,title]of options){const option=el('option',title);option.value=String(value);control.appendChild(option);}wrap.append(text,control);return[wrap,control];}
  const[pastGroup,past]=select('Previous days',[[0,'None'],[1,'1 day'],[2,'2 days'],[7,'7 days'],[30,'30 days'],[90,'90 days'],['all','All']]);pastGroup.id='v26PastControls';past.addEventListener('change',()=>change({past:past.value==='all'?'all':Number(past.value)}));
  const[savedGroup,saved]=select('Saved tasks',[['days','Date window'],['all','All saved future tasks']]);saved.addEventListener('change',()=>{lastDaysMode=saved.value;change({mode:lastDaysMode});});
  days.append(futureGroup,custom,pastGroup,savedGroup);host.appendChild(days);
  const range=el('div',undefined,'v26-toolbar-row');range.id='v26RangeControls';
  const[startLabel,start]=input('date','Start date',draft.start),[endLabel,end]=input('date','End date',draft.end);start.min=end.min='0001-01-01';start.max=end.max='9999-12-31';
  startLabel.classList.add('v26-control-group');endLabel.classList.add('v26-control-group');
  for(const[control,field]of[[start,'start'],[end,'end']])control.addEventListener('input',()=>{draft[field]=control.value;clearInvalid(start);clearInvalid(end);});
  const applyRange=button('Apply range',()=>{
   if(!Number.isFinite(ms(start.value))){invalid(start,'Choose a valid start date.');return;}
   if(!Number.isFinite(ms(end.value))||start.value>end.value){invalid(end,'Choose a valid end date on or after the start date.');return;}
   clearInvalid(start);clearInvalid(end);draft.start=start.value;draft.end=end.value;change({mode:'range',start:draft.start,end:draft.end});
  });range.append(startLabel,endLabel,applyRange);host.appendChild(range);
  const hint=el('p',undefined,'v26-toolbar-hint'),error=el('p',undefined,'v26-toolbar-error'),notice=el('p',undefined,'v26-toolbar-notice');hint.id='v26AgendaHint';days.setAttribute('aria-describedby',hint.id);range.setAttribute('aria-describedby',hint.id);error.id='v26AgendaError';error.setAttribute('role','alert');customInput.setAttribute('aria-describedby',error.id);start.setAttribute('aria-describedby',error.id);end.setAttribute('aria-describedby',error.id);notice.setAttribute('role','status');
  const pager=el('div',undefined,'v26-toolbar-pager');pager.id='v26AgendaPager';host.append(hint,error,notice,pager);
  toolbar={host,modes,period,count,days,range,future:futureGroup,presets,customInput,applyDays,past,saved,start,end,hint,error,notice,pager};
  const sidebar=document.querySelector('#tab-tasks .sidebar'),details=el('details');details.id='v26Earlier';details.open=true;details.appendChild(el('summary','Earlier unfinished'));details.appendChild(el('p','Drag a task onto a day to reschedule, or use Assign to choose a date.'));const list=el('div');list.id='v26EarlierList';details.appendChild(list);sidebar?.appendChild(details);
 }
 function afterRender(){
  if(!core)return;syncAccount();mount();if(!toolbar)return;
  renderToolbar();const tasks=core.getState().tasks||[],today=core.today(),pager=toolbar.pager;pager.replaceChildren();const box=document.getElementById('binsContainer');
  if(prefs.mode==='all'){
   const selected=future(tasks,today,prefs.past).filter(core.matches);renderList(box,selected,allLimit,()=>{allLimit+=ITEMS;core.render();},'No saved future tasks');
   setSummary('All saved future tasks',selected.length+' saved tasks · repeating tasks shown as saved occurrences');
  }else{
   const[a,b]=bounds(tasks,today,prefs),total=Math.floor((b-a)/DAY)+1;
   setSummary(formatDate(key(a))+' – '+formatDate(key(b)),total.toLocaleString('en-US')+' calendar '+(total===1?'day':'days'));
   if(total>PAGE){
    const pageStart=key(a+(offset||0)*DAY),pageEnd=key(a+Math.min(total-1,(offset||0)+PAGE-1)*DAY);
    pager.appendChild(el('span','Showing '+formatDate(pageStart)+' – '+formatDate(pageEnd)));
    const prev=button('Previous 60 days',()=>{offset=Math.max(0,offset-PAGE);core.render();});prev.disabled=offset===0;
    const next=button('Next 60 days',()=>{offset+=PAGE;core.render();});next.disabled=offset+PAGE>=total;pager.append(prev,next);
   }
  }
  const pending=tasks.filter(t=>core.isOverdue?core.isOverdue(t):overdue(t,today)).sort((a,b)=>a.date.localeCompare(b.date)||String(a.id).localeCompare(String(b.id)));
  const panel=document.getElementById('v26Earlier');if(panel){panel.querySelector('summary').textContent='Earlier unfinished ('+pending.length+')';renderList(document.getElementById('v26EarlierList'),pending,sideLimit,()=>{sideLimit+=ITEMS;core.render();},'No earlier unfinished tasks',true);}
 }
 function install(adapter){core=adapter;syncAccount();}
 return{install,getDays,afterRender,overdue,ms,bounds,future,validate,defaults};
});
