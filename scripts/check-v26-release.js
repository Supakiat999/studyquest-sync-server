const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const pub=path.resolve(__dirname,'../public'),manifest=JSON.parse(fs.readFileSync(path.join(pub,'v26-version.json'),'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(pub,file))).digest('hex');
assert.equal(manifest.version,26);assert.equal(manifest.hash,hash('claudever26.html'));
for(const [file,digest]of Object.entries(manifest.assets)){assert.equal(path.basename(file),file);assert.equal(hash(file),digest,file);}
const html=fs.readFileSync(path.join(pub,'claudever26.html'),'utf8');
assert.ok(!html.includes("location.replace('http://127.0.0.1:3000/claudever26.html')"));
assert.ok(html.includes('function moveV26EarlierTask('));assert.ok(html.includes('window.StudyQuestV26Agenda.install('));
console.log('Hosted v26 page and all '+Object.keys(manifest.assets).length+' asset hashes verified; laptop redirect guard excluded.');
