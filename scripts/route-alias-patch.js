const fs = require("node:fs");
const path = require("node:path");

const serverPath = path.join(__dirname, "..", "server.js");
let source = fs.readFileSync(serverPath, "utf8");
const existing = 'if (url.pathname === "/" || url.pathname === "/app.html" || url.pathname === "/claudever9.html") {';
const target = 'if (url.pathname === "/" || url.pathname === "/claudever9.html") {';

if (!source.includes('const V13_HTML_PATH = path.join(ROOT, "public", "claudever13.html");')) {
  if (!source.includes('const HTML_PATH = path.join(ROOT, "public", "claudever9.html");')) {
    throw new Error("Could not find the StudyQuest HTML path constant to patch.");
  }
  source = source.replace(
    'const HTML_PATH = path.join(ROOT, "public", "claudever9.html");',
    'const HTML_PATH = path.join(ROOT, "public", "claudever9.html");\nconst V13_HTML_PATH = path.join(ROOT, "public", "claudever13.html");'
  );
}

if (!source.includes(existing)) {
  if (!source.includes(target)) {
    throw new Error("Could not find the StudyQuest HTML route to patch.");
  }
  source = source.replace(target, existing);
}

if (!source.includes('url.pathname === "/v13"')) {
  const routeMarker = '    if (url.pathname === "/" || url.pathname === "/app.html" || url.pathname === "/claudever9.html") {';
  const v13Route = `    if (url.pathname === "/v13" || url.pathname === "/claudever13.html") {
      send(req, res, 200, fs.readFileSync(V13_HTML_PATH), { "content-type": "text/html; charset=utf-8" });
      return;
    }

`;
  if (!source.includes(routeMarker)) {
    throw new Error("Could not find the StudyQuest main HTML route to add v13 routes.");
  }
  source = source.replace(routeMarker, v13Route + routeMarker);
}

if (!source.includes("V13_HTML_PATH")) {
  throw new Error("Could not find the StudyQuest HTML route to patch.");
}

fs.writeFileSync(serverPath, source);
console.log("Ensured /app.html and /v13 route aliases.");
