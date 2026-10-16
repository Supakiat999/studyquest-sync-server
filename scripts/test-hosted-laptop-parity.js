// Cross-target regression: the laptop page is the presentation reference.
// Reuse synthetic HTTP accounts and disposable Chrome, never user profiles.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
let source=fs.readFileSync(path.join(__dirname,'test-v24-save-failures.js'),'utf8');
source=source.slice(0,source.indexOf('const results=[];'))
 .replace("let mode='local'","let activeVersion=25;\nlet mode='local'")
 .replace("if(url.pathname==='/v24')filename='claudever24.html';","if(['/v24','/v25'].includes(url.pathname))filename='claudever'+url.pathname.slice(2)+'.html';")
 .replace("filename==='claudever24.html' && mode==='hosted'","/^claudever(?:24|25)\\.html$/.test(filename) && mode==='hosted'")
 .replace("mode==='hosted'?'/v24':'/claudever24.html'","mode==='hosted'?'/v'+activeVersion:'/claudever'+activeVersion+'.html'")
 .replace("res.setHeader('content-type',filename", "if(mode==='local' && /^claudever(?:24|25)\\.html$/.test(filename))body=body.replace('</head>','<link rel=\"stylesheet\" href=\"/studyquest-device-date-shifts.css\"></head>').replace('</body>','<script src=\"/studyquest-device-date-shifts.js\"></script></body>');\n  res.setHeader('content-type',filename")
 .replaceAll("date:'2026-10-08'","date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(new Date())");
source+=`
const report={targets:[],externalApplicationRequestsBlocked:true,syntheticAccountsOnly:true};
const output=process.env.STUDYQUEST_PARITY_OUTPUT || path.join(hostedRoot,'.test-artifacts','laptop-parity');fs.mkdirSync(output,{recursive:true});
async function measure(page){return page.evaluate(()=>{
 const box=selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),font:s.fontFamily,fontSize:s.fontSize,display:s.display,position:s.position};};
 return {header:box('#app>header'),nav:box('#app>.tabs'),xp:box('.xp-block'),stats:box('.header-stats'),command:box('.today-command-strip'),task:box('.task-item'),title:box('.task-title-text'),bodyFont:getComputedStyle(document.body).fontFamily,sidebar:!!document.getElementById('v24NavBrand'),overflow:document.documentElement.scrollWidth>innerWidth};
});}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));loopback='http://127.0.0.1:'+server.address().port;
 let reference;
 for(const [runtime,version]of [['local',25],['hosted',24],['hosted',25]]){
  mode=runtime;activeVersion=version;origin=runtime==='local'?loopback:'https://studyquest-parity-fixture.onrender.com';
  profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-laptop-parity-'));await launch();const page=await open();
  await reset(page,25);await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(()=>{activeFilter='all';activeCatFilter=null;state.fileLinks.forEach(f=>{f.path=f.url;f.cat='other';});state.theme='dark';applyTheme('dark');renderAll();activateStudyQuestTab('tasks');});await page.waitForTimeout(400);
  // Fixture startup can finish its read-only review after seeding. Close that synthetic dialog.
  await page.evaluate(()=>{for(const overlay of document.querySelectorAll('.modal-overlay.open'))closeModal(overlay.id);});await page.waitForTimeout(100);
  assert.equal(await page.locator('.modal-overlay.open').count(),0);
  // Match the screenshot's visible anchor; hosted sync status adds a line above navigation.
  await page.evaluate(()=>scrollTo(0,document.querySelector('#app>.tabs').getBoundingClientRect().top+scrollY-document.querySelector('#app>header').getBoundingClientRect().height));
  const metrics=await measure(page);report.targets.push({runtime,version,metrics});
  if(runtime==='local')reference=metrics;
  else {assert.equal(metrics.sidebar,false);assert.equal(metrics.nav.position,reference.nav.position);assert.equal(metrics.bodyFont,reference.bodyFont);assert.equal(metrics.xp.display,reference.xp.display);for(const key of ['header','nav','xp','stats','command','task','title'])for(const prop of Object.keys(reference[key])){if(typeof reference[key][prop]==='number')assert.ok(Math.abs(metrics[key][prop]-reference[key][prop])<=1,runtime+version+' '+key+'.'+prop+': '+metrics[key][prop]+' vs '+reference[key][prop]);else assert.equal(metrics[key][prop],reference[key][prop],key+'.'+prop)};}
  await page.screenshot({path:path.join(output,runtime+'-v'+version+'-desktop.png'),fullPage:false});
  if(runtime==='hosted'){
   const before=await bundle(page);await page.evaluate(()=>openCreateTask());await page.locator('#taskName').fill('Synthetic parity edit');
   assert.equal(await page.locator('#taskModal').isVisible(),true);await page.evaluate(()=>closeModal('taskModal'));
   // Inspecting and closing an editor must not change confirmed account data.
   assert.deepEqual((await bundle(page)).outbox,before.outbox);
   for(const tab of ['calendar','timer','progress','grades','class-guide','weekly','notes','files','checklist','travel']){await page.evaluate(name=>activateStudyQuestTab(name),tab);assert.equal(await page.locator('#tab-'+tab).isVisible(),true,tab);}
   await page.evaluate(()=>activateStudyQuestTab('tasks'));
   for(const width of [390,820]){await page.setViewportSize({width,height:1000});await page.waitForTimeout(150);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1,'No viewport overflow at '+width);}
  }
  await stopChrome();
 }
 report.ok=true;fs.writeFileSync(path.join(output,'parity.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(error=>{report.ok=false;report.error=String(error.stack);fs.writeFileSync(path.join(output,'parity.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;}).finally(async()=>{await stopChrome();server.close();});
`;
const test=new Module(__filename,module);test.filename=__filename;test.paths=module.paths;test._compile(source,__filename);
