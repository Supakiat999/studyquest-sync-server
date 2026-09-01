const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.FIXTURE_PORT || 3109);
const make = (count, prefix) => Array.from({ length:count }, (_, index) => ({ id:`${prefix}-${index}`, title:`${prefix} ${index}` }));
const semesters = make(4, "semester");
const categories = [
  { id:"appdev", name:"Application Development", color:"#7c6af7", icon:"💻" },
  { id:"signals", name:"Signal and Linear System", color:"#f76a9e", icon:"📡" },
  { id:"ai", name:"AI", color:"#6af7e0", icon:"🤖" },
  { id:"engmgmt", name:"Engineering Management", color:"#f7c06a", icon:"📊" },
];
const accountState = {
  tasks:make(286, "task"), categories, notes:make(20, "note"), fileLinks:[{ id:"file-shared", name:"Shared file" }],
  checklistItems:make(163, "check"), trips:make(1, "trip"), tracker:{ weeks:make(20, "week") }, trackerSemesters:semesters,
  grades:Object.fromEntries(make(44, "grade").map((item) => [item.id, { id:item.id, name:item.title, scores:[] }])),
  sessionGoals:{},
  updatedAt:Date.parse("2026-09-01T02:17:27.000Z"),
};
const deviceState = {
  tasks:accountState.tasks.slice(0, 78), categories, notes:accountState.notes,
  fileLinks:[accountState.fileLinks[0], { id:"file-device-only", name:"Device-only file" }], checklistItems:[], trips:[],
  tracker:{ weeks:[] }, trackerSemesters:semesters,
  grades:Object.fromEntries(Object.entries(accountState.grades).slice(0, 42)),
  sessionGoals:{},
  updatedAt:Date.parse("2026-08-04T14:15:15.000Z"),
};
const requests = [];
const stable = fs.readFileSync(path.join(root, "public", "claudever9.html"), "utf8")
  .replace("</head>", `<script>window.__STUDYQUEST_AUTH_USER__={username:"admin"};window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_RECOVERY_UX_MODE__="all";localStorage.setItem("studyquest_v3_admin",${JSON.stringify(JSON.stringify(deviceState))});</script></head>`)
  .replace("</body>", `<script src="/recovery-ux-v2-core.js"></script><script src="/recovery-ux-v2.js"></script><button id="openRecoveryFixture" type="button" style="position:fixed;z-index:100000;right:10px;top:10px" onclick='openAccountStateRecovery(Object.assign(defaultState(),${JSON.stringify(deviceState)}),Object.assign(defaultState(),${JSON.stringify(accountState)}),573,"Synthetic recovery comparison","${"a".repeat(64)}")'>Open recovery fixture</button></body>`);

function json(res, status, payload) {
  res.writeHead(status, { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  requests.push({ method:req.method, path:url.pathname, at:new Date().toISOString() });
  if (url.pathname === "/" || url.pathname === "/app.html") {
    res.writeHead(200, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store" });
    return res.end(stable);
  }
  if (url.pathname === "/data-recovery") {
    res.writeHead(200, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store" });
    return res.end(fs.readFileSync(path.join(root, "public", "device-recovery-v2.html")));
  }
  if (["/recovery-ux-v2-core.js", "/recovery-ux-v2.js", "/device-recovery-v2.js"].includes(url.pathname)) {
    res.writeHead(200, { "content-type":"text/javascript; charset=utf-8", "cache-control":"no-store" });
    return res.end(fs.readFileSync(path.join(root, "public", path.basename(url.pathname))));
  }
  if (url.pathname === "/api/me") return json(res, 200, { ok:true, user:{ username:"admin" } });
  if (url.pathname === "/api/v2/state" && req.method === "GET") {
    return json(res, 200, { ok:true, state:accountState, revision:573, stateHash:"a".repeat(64) });
  }
  if (url.pathname === "/fixture-device-state") return json(res, 200, { state:deviceState });
  if (url.pathname === "/fixture-requests") return json(res, 200, { requests });
  if (url.pathname === "/api/recovery/versions" && req.method === "GET") {
    return json(res, 200, { ok:true, versions:[{ id:"1", createdAt:"2026-08-31T15:48:00.000Z", sourceDevice:"fixture", summary:{ tasks:286, notes:20, files:1, trips:1, weeklyWeeks:20, weeklySemesters:4 } }] });
  }
  if (url.pathname === "/api/recovery/versions/1/preview" && req.method === "POST") {
    return json(res, 200, {
      ok:true, unchanged:true, previewToken:"fixture-preview", source:{ id:"1", revision:572, stateHash:"b".repeat(64) },
      current:{ revision:573, stateHash:"a".repeat(64), summary:{ tasks:286, notes:20, files:1, trips:1, weeklyWeeks:20, weeklySemesters:4 } },
      proposedSummary:{ tasks:286, notes:20, files:1, trips:1, weeklyWeeks:20, weeklySemesters:4 },
      comparison:{ recoverableMissing:[], currentOnly:[], changed:[], counts:{ recoverableMissing:0 } },
    });
  }
  if (url.pathname === "/api/health") return json(res, 200, { ok:true });
  return json(res, 404, { ok:false, error:"FIXTURE_ROUTE_NOT_FOUND" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Recovery UX fixture ready at http://127.0.0.1:${port}/\n`);
});
