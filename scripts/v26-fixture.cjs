// Synthetic PGlite process, never a real PostgreSQL/Neon connection.
const {spawn}=require('node:child_process'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
module.exports=async function fixture(settings={}){
 const password=crypto.randomBytes(20).toString('hex'),invite=crypto.randomBytes(20).toString('hex'),origin='http://127.0.0.1:32525';
 const env={...process.env,PORT:'32525',DATABASE_URL:'postgresql://qa:qa@127.0.0.1/v24_isolated',STUDYQUEST_ADMIN_PASSWORD:password,STUDYQUEST_INVITE_CODE:invite,STUDYQUEST_V15_ACCESS:'all',STUDYQUEST_V24_ACCESS:'off',STUDYQUEST_MAIN_VERSION:'15',STUDYQUEST_SAFE_SYNC_MODE:'all',NODE_ENV:'test',...settings};
 const child=spawn(process.execPath,['--require',path.join(__dirname,'v24-isolated-db.cjs'),'server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
 let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
 const request=async(url,options={},cookie)=>{const res=await fetch(origin+url,{...options,headers:{origin,...options.headers,...(cookie?{cookie}:{})},redirect:'manual'});const text=await res.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:res.status,body,cookie:res.headers.get('set-cookie')?.split(';')[0],location:res.headers.get('location'),headers:res.headers};};
 const post=(url,body,cookie)=>request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},cookie);
 try{
  for(let i=0;;i++){try{if((await request('/api/health')).status===200)break;}catch{}if(i>80||child.exitCode!==null)throw new Error(logs||'Fixture startup timeout');await new Promise(r=>setTimeout(r,250));}
 }catch(error){child.kill();throw error;}
 const login=await post('/api/login',{username:'admin',password});if(login.status!==200){child.kill();throw new Error(JSON.stringify(login.body));}
 const register=async username=>{const accountPassword=crypto.randomBytes(20).toString('hex');const result=await post('/api/register',{username,password:accountPassword,inviteCode:invite});if(result.status!==201)throw new Error(JSON.stringify(result.body));return {username,password:accountPassword,cookie:result.cookie};};
 return {origin,password,invite,child,request,post,admin:login.cookie,register,close:()=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill();})};
};
