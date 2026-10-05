/* Presentation and accessibility only: no account state writes or storage migrations. */
(function(root){
  'use strict';
  const $=id=>root.document.getElementById(id);
  const PAGES={tasks:['Today','Capture a task, choose what matters, and work through your day.'],calendar:['Calendar','Switch between day, week, and month. Select a date to schedule something.'],timer:['Focus','Choose a subject or task, set your session length, then start the timer.'],progress:['Progress','See your study time, completed tasks, and milestones in one place.'],grades:['Grades','Choose your program and semester to manage subjects, scores, and grade cutoffs.'],'class-guide':['Class guide','Browse your program and subjects. Your study tracker is a separate workspace.'],notes:['Notes','Choose a notebook, then add or edit a note. Notebook and note ordering are independent.'],files:['Files','Keep links to files and websites together. Saving a link does not upload the file.'],checklist:['Checklist','Build repeatable checklists. Use groups and filters to keep routines organized.'],weekly:['Study tracker','Use weekly schedules or create independent manual courses. Weekly-based subjects are optional in Settings.'],travel:['Travel','Organize trips, places, and itineraries. Start with a trip to reveal its planning tools.']};
  const LABELS={calendarAnchorDate:'Calendar date',focusDur:'Focus session length in minutes',shortBreakDur:'Short break length in minutes',longBreakDur:'Long break length in minutes',spotifyVol:'Music volume',ambientVol:'Ambient sound volume',timerSubject:'Focus subject',weeklyProgramSelect:'Weekly program',qcDate:'Start date',qcEndDate:'End date',qcTime:'Time',csCredits:'Subject credits',taskDate:'Task date',semTrackerSel:'Tracker semester',playBtn:'Start or pause focus timer',globalSearchInput:'Search tasks, notes, and records',checkNewGroup:'New checklist group',todayInlineCapture:'Quick add task',v21CapacityMode:'Daily workload limit mode'};
  let installed=false,enhancing=false,pending=false,observer,serial=0,appWasInert=null,prefs={density:'comfortable',tips:true};
  const prefKey='studyquest_v24_interface';
  function setPrefs(){root.document.body.dataset.v24Density=prefs.density;root.document.body.dataset.v24Tips=String(prefs.tips);}
  function savePrefs(){setPrefs();try{root.localStorage.setItem(prefKey,JSON.stringify(prefs));}catch{$('v24DisplayMessage').textContent='Display changed for this visit. The browser could not save this preference; your records are unchanged.';}}
  function schedule(){if(pending)return;pending=true;root.requestAnimationFrame(()=>{pending=false;enhance();});}
  function header(){
    const nav=root.document.querySelector('#app>.tabs'),head=root.document.querySelector('#app>header');if(!nav||!head)return;
    nav.setAttribute('aria-orientation','vertical');
    if(!$('v24NavBrand')){const brand=root.document.createElement('div');brand.id='v24NavBrand';brand.className='v24-nav-brand';brand.innerHTML='StudyQuest<small>YOUR WORKSPACE · V24</small>';nav.prepend(brand);
      const foot=root.document.createElement('div');foot.className='v24-nav-foot';foot.innerHTML='<button type="button" id="v24OpenSettings">Settings</button><button type="button" id="v24OpenRecovery">Backup & recovery</button>';nav.append(foot);
      $('v24OpenSettings').onclick=()=>root.openProfileSettings();$('v24OpenRecovery').onclick=()=>{const d=$('v24RecoveryDetails');if(d)d.open=true;$('v21Help').scrollIntoView({block:'center'});$('v21Check').focus();};
    }
    if(!$('v24Milestones')){const block=head.querySelector('.xp-block'),stats=head.querySelector('.header-stats');if(block){const details=root.document.createElement('details');details.id='v24Milestones';details.className='v24-milestones';details.innerHTML='<summary>Progress & milestones</summary>';block.before(details);details.append(block);if(stats)details.append(stats);}}
    if(!$('v24Tools')){const actions=head.querySelector('.header-actions');if(actions){const details=root.document.createElement('details');details.id='v24Tools';details.className='v24-tools';details.innerHTML='<summary>Tools</summary><div class="v24-tools-content" id="v24ToolsContent"></div>';const extra=[...actions.children].filter(e=>e.id!=='profileBtn'&&!(e.getAttribute('onclick')||'').includes('openCreateTask'));actions.insertBefore(details,$('profileBtn'));extra.forEach(e=>$('v24ToolsContent').append(e));if($('v24Milestones'))$('v24ToolsContent').append($('v24Milestones'));}}
    if(!$('v24MobileNav')){const box=root.document.createElement('div');box.id='v24MobileNav';box.className='v24-mobile-nav';box.innerHTML='<label for="v24SectionSelect">Go to section</label><select id="v24SectionSelect"></select>';head.append(box);$('v24SectionSelect').onchange=e=>{const name=e.target.value,button=root.document.querySelector(`.tabs [aria-controls="tab-${name}"]`);if(button)root.switchTab(name,button);};}
    const select=$('v24SectionSelect');
    const buttons=[...nav.querySelectorAll('.tab[aria-controls]')].filter(b=>{for(let node=b;node&&node!==nav;node=node.parentElement)if(getComputedStyle(node).display==='none'||node.hidden)return false;return true;});
    // Hidden desktop parent on mobile does not make individual display styles disappear.
    const names=buttons.map(b=>b.getAttribute('aria-controls').slice(4));
    const signature=names.join('|');if(select.dataset.signature!==signature){select.replaceChildren(...names.map(name=>{const o=root.document.createElement('option');o.value=name;o.textContent=PAGES[name]?.[0]||name;return o;}));select.dataset.signature=signature;}
    const active=root.document.querySelector('.main.active[id^="tab-"]')?.id.slice(4)||'tasks';select.value=active;
    if($('activeSectionLabel')&&PAGES[active])$('activeSectionLabel').textContent=PAGES[active][0];
    const help=$('v21Help');if(help&&!$('v24RecoveryDetails')){const details=root.document.createElement('details');details.id='v24RecoveryDetails';details.className='v24-recovery-details';details.innerHTML='<summary>Backup & recovery tools</summary>';for(const node of [...help.childNodes])if(node!==$('v21Message'))details.append(node);help.prepend(details);}
    if($('v21Message')?.dataset.error==='true'&&$('v24RecoveryDetails'))$('v24RecoveryDetails').open=true;
    const message=$('v21Message');if(message)message.classList.toggle('v24-default-message',message.textContent.startsWith('Opening this version does not approve a merge'));
  }
  function settings(){const modal=$('profileSettingsModal')?.querySelector('.modal');if(!modal||$('v24DisplaySettings'))return;
    const panel=root.document.createElement('section');panel.id='v24DisplaySettings';panel.className='v24-display-settings';panel.innerHTML='<h3>Interface</h3><label for="v24Density">Control spacing<select id="v24Density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label for="v24Tips">Show helpful page tips<input type="checkbox" id="v24Tips"></label><p id="v24DisplayMessage">These display preferences save only on this browser. Your existing themes remain available below.</p>';
    const theme=$('profileThemeGrid');if(theme)theme.previousElementSibling.before(panel);else modal.append(panel);
    $('v24Density').value=prefs.density;$('v24Tips').checked=prefs.tips;
    $('v24Density').onchange=e=>{prefs.density=e.target.value;savePrefs();};$('v24Tips').onchange=e=>{prefs.tips=e.target.checked;savePrefs();};
    const links=root.document.createElement('nav');links.className='v24-settings-links';links.setAttribute('aria-label','Settings sections');
    for(const [id,name] of [['profileName','Account'],['v21TrackerSettings','Study tracker'],['v21Workload','Workload'],['v24DisplaySettings','Interface'],['profileThemeGrid','Themes']]){const a=root.document.createElement('a');a.href='#'+id;a.textContent=name;a.onclick=e=>{e.preventDefault();const target=$(id);target?.scrollIntoView({block:'start',behavior:'instant'});};links.append(a);}
    modal.children[0].after(links);
  }
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
  function help(){for(const [name,[,description]] of Object.entries(PAGES)){const page=$('tab-'+name);if(!page||page.querySelector('.v24-section-help'))continue;const guide=root.document.createElement('p');guide.className='v24-section-help';guide.textContent=description;page.prepend(guide);}}
  function modalStack(){const overlays=[...root.document.querySelectorAll('.modal-overlay.open')],top=overlays.at(-1),app=$('app');
    for(const overlay of root.document.querySelectorAll('.modal-overlay')){const behind=overlay.classList.contains('open')&&overlay!==top;if(overlay.inert!==behind)overlay.inert=behind;if(behind)overlay.setAttribute('aria-hidden','true');else overlay.removeAttribute('aria-hidden');}
    if(top&&app){if(appWasInert===null)appWasInert=app.inert;app.inert=true;}else if(app&&appWasInert!==null){app.inert=appWasInert;appWasInert=null;}
    if(root.document.body.classList.contains('modal-open')!==!!top)root.document.body.classList.toggle('modal-open',!!top);
  }
  function enhance(){if(!installed||enhancing)return;enhancing=true;observer?.disconnect();try{header();settings();help();labels(root.document);modalStack();}finally{enhancing=false;observer?.observe(root.document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});}}
  function visibleFocusables(dialog){return [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[inert]')&&!e.closest('details:not([open])>*:not(summary)'));}
  function install(){if(installed)return;installed=true;
    try{const saved=JSON.parse(root.localStorage.getItem(prefKey)||'{}');prefs={density:saved.density==='compact'?'compact':'comfortable',tips:saved.tips!==false};}catch{}setPrefs();
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
  root.StudyQuestV24={install,enhance,PAGES};
})(window);
