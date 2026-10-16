/* Presentation and accessibility only: no account state writes or storage migrations. */
(function(root){
  'use strict';
  const $=id=>root.document.getElementById(id);
  const LABELS={calendarAnchorDate:'Calendar date',focusDur:'Focus session length in minutes',shortBreakDur:'Short break length in minutes',longBreakDur:'Long break length in minutes',spotifyVol:'Music volume',ambientVol:'Ambient sound volume',timerSubject:'Focus subject',weeklyProgramSelect:'Weekly program',qcDate:'Start date',qcEndDate:'End date',qcTime:'Time',csCredits:'Subject credits',taskDate:'Task date',semTrackerSel:'Tracker semester',playBtn:'Start or pause focus timer',globalSearchInput:'Search tasks, notes, and records',checkNewGroup:'New checklist group',todayInlineCapture:'Quick add task',v21CapacityMode:'Daily workload limit mode'};
  let installed=false,enhancing=false,pending=false,observer,serial=0,appWasInert=null;

  function schedule(){if(pending)return;pending=true;root.requestAnimationFrame(()=>{pending=false;enhance();});}
  function labels(host){
    for(const [id,label] of Object.entries(LABELS)){const node=$(id);if(node&&!node.hasAttribute('aria-label'))node.setAttribute('aria-label',label);}
    for(const control of host.querySelectorAll('input:not([type=hidden]),select,textarea')){
      if(control.hasAttribute('aria-label')||control.hasAttribute('aria-labelledby')||control.labels?.length)continue;
      const group=control.closest('.form-group'),label=group?.querySelector('label');
      if(label&&!label.querySelector('input,select,textarea')&&group.querySelectorAll('input:not([type=hidden]),select,textarea').length===1){if(!control.id)control.id='v24-field-'+(++serial);label.htmlFor=control.id;continue;}
      let name;
      const handler=control.getAttribute('onchange')||'',field=handler.match(/,'([A-Za-z]+)',this\.value/);
      if(field&&/^updateTravel/.test(handler)){const labels={title:'Title',notes:'Notes',booking:'Booking reference',startTime:'Start time',endTime:'End time',durationMins:'Duration in minutes',categoryId:'Category',placeId:'Linked place',date:'Date',name:'Name',label:'Day title',status:'Status',cost:'Cost',travelers:'Number of travelers'};const kind=/Activity/.test(handler)?'Activity':/Place/.test(handler)?'Place':/Day/.test(handler)?'Day':/Booking/.test(handler)?'Booking':'Trip';name=kind+' — '+(labels[field[1]]||field[1].replace(/([a-z])([A-Z])/g,'$1 $2'));}
      if(!name){for(const [prefix,label] of [['travelNewActTitle_','New activity title'],['travelNewActTime_','New activity start time'],['travelNewActCategory_','New activity category'],['travelAddPlace_','Saved place to add']])if(control.id.startsWith(prefix)){name=label;break;}}
      if(!name)name=control.title||control.placeholder;
      if(!name&&control.closest('#sessionGoalsPanel'))name=(control.closest('[style]')?.textContent.trim().slice(0,50)||'Subject')+' session goal in minutes';
      if(!name){const row=control.closest('tr');if(row){const col=Array.from(control.closest('td,th')?.parentElement?.children||[]).indexOf(control.closest('td,th'));name=[row.querySelector('th,td')?.textContent.trim().slice(0,60),row.closest('table')?.querySelectorAll('thead th')[col]?.textContent.trim()].filter(Boolean).join(' — ');}}
      if(!name&&control.id)name=control.id.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ');
      if(!name){const near=control.parentElement?.textContent.trim();if(near&&near.length<100)name=near;}
      if(name)control.setAttribute('aria-label',name);
    }
    // The travel editor used placeholder-only fields. Keep its grid cells intact
    // while adding visible captions; move the original controls, never clone them.
    for(const control of host.querySelectorAll('.tv-form-grid>input,.tv-form-grid>select,.tv-form-grid>textarea')){
      const name=control.getAttribute('aria-label');if(!name||control.labels?.length)continue;
      const label=root.document.createElement('label');label.className='v24-control-label';const caption=root.document.createElement('span');caption.textContent=name;control.before(label);label.append(caption,control);
    }
    for(const button of host.querySelectorAll('button')){
      if(button.hasAttribute('aria-label'))continue;const text=button.textContent.trim(),handler=button.getAttribute('onclick')||'',title=button.title;
      if(title){button.setAttribute('aria-label',title);continue;}
      if(/^[✕×✖x]$/i.test(text)){button.setAttribute('aria-label',/delete|remove|trash/i.test(handler)?'Remove item':'Close dialog');continue;}
      if(/^[←→↑↓↺⏭▶⏸✎✏️]+$/.test(text)){const action=/edit/i.test(handler)?'Edit item':/reset/i.test(handler)?'Reset timer':/skip/i.test(handler)?'Skip timer phase':text==='←'?'Previous':text==='→'?'Next':text==='↑'?'Move up':text==='↓'?'Move down':'Start or pause';button.setAttribute('aria-label',action);}
    }
  }
  function modalStack(){const overlays=[...root.document.querySelectorAll('.modal-overlay.open')],top=overlays.at(-1),app=$('app');
    for(const overlay of root.document.querySelectorAll('.modal-overlay')){const behind=overlay.classList.contains('open')&&overlay!==top;if(overlay.inert!==behind)overlay.inert=behind;if(behind)overlay.setAttribute('aria-hidden','true');else overlay.removeAttribute('aria-hidden');}
    if(top&&app){if(appWasInert===null)appWasInert=app.inert;app.inert=true;}else if(app&&appWasInert!==null){app.inert=appWasInert;appWasInert=null;}
    if(root.document.body.classList.contains('modal-open')!==!!top)root.document.body.classList.toggle('modal-open',!!top);
  }
  function enhance(){if(!installed||enhancing)return;enhancing=true;observer?.disconnect();try{labels(root.document);modalStack();}finally{enhancing=false;observer?.observe(root.document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});}}
  function visibleFocusables(dialog){return [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[inert]')&&!e.closest('details:not([open])>*:not(summary)'));}
  function install(){if(installed)return;installed=true;
    const skip=root.document.createElement('a');skip.className='v24-skip';skip.href='#tab-tasks';skip.textContent='Skip to main content';skip.onclick=e=>{e.preventDefault();const page=root.document.querySelector('.main.active');if(page){page.tabIndex=-1;page.focus();page.scrollIntoView({block:'start'});}};root.document.body.prepend(skip);
    const open=root.openModal,close=root.closeModal;
    const toast=root.showToast;let lastToast='',lastToastAt=0;
    root.showToast=function(message,...args){const now=Date.now();if(String(message)===lastToast&&now-lastToastAt<2500)return;lastToast=String(message);lastToastAt=now;return toast(message,...args);};
    if($('toastContainer')){$('toastContainer').setAttribute('role','status');$('toastContainer').setAttribute('aria-live','polite');}
    root.openModal=function(id){const overlay=$(id);if(overlay)root.document.body.append(overlay);const result=open(id);enhance();return result;};
    root.closeModal=function(id){const result=close(id);enhance();return result;};
    // Replace legacy independent floating panels with the same accessible dialog surface.
    root.showInlinePanel=function(id,html){let overlay=$(id);if(!overlay){overlay=root.document.createElement('div');overlay.id=id;root.document.body.append(overlay);}overlay.className='modal-overlay';overlay.removeAttribute('style');overlay.innerHTML='<div class="modal v24-inline-dialog"><button type="button" class="btn btn-ghost v24-inline-close" aria-label="Close dialog">×</button><div class="v24-inline-content"></div></div>';overlay.querySelector('.v24-inline-content').innerHTML=html;overlay.querySelector('.v24-inline-close').onclick=()=>root.closeModal(id);overlay.querySelector('.modal').setAttribute('aria-label',({curriculumBuilderPanel:'Add program',curriculumEditorPanel:'Edit program',categoryTrashPanel:'Category trash',trackerSemPanel:'Tracker semesters',semSubjEditor:'Semester subjects'})[id]||'Editor');root.openModal(id);};
    // Capture Tab before the legacy trap, which counted hidden controls.
    root.document.addEventListener('keydown',event=>{const top=[...root.document.querySelectorAll('.modal-overlay.open')].at(-1);if(!top)return;if(event.key==='Escape'&&((top.id==='v21CourseDialog'&&$('mcCancel')?.disabled)||(top.id==='v21RecoveryModal'&&$('v21RecoveryConfirm')?.disabled))){event.preventDefault();event.stopImmediatePropagation();return;}if(event.key!=='Tab')return;const dialog=top.querySelector('.modal')||top,items=visibleFocusables(dialog);if(!items.length){event.preventDefault();event.stopImmediatePropagation();dialog.tabIndex=-1;dialog.focus();return;}const first=items[0],last=items.at(-1);if(event.shiftKey&&(root.document.activeElement===first||!dialog.contains(root.document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(root.document.activeElement===last||!dialog.contains(root.document.activeElement))){event.preventDefault();first.focus();}event.stopImmediatePropagation();},true);
    for(const name of ['renderAll','switchTab','openProfileSettings','renderWeekly','renderFiles','renderNotes','renderChecklist']){const original=root[name];if(typeof original==='function')root[name]=function(...args){const result=original.apply(this,args);enhance();return result;};}
    observer=new root.MutationObserver(schedule);enhance();
  }
  root.StudyQuestCompactInterface={install,enhance};
})(window);
