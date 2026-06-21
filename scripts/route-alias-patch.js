const fs = require("node:fs");
const path = require("node:path");

const serverPath = path.join(__dirname, "..", "server.js");
const source = fs.readFileSync(serverPath, "utf8");
const existing = 'if (url.pathname === "/" || url.pathname === "/app.html" || url.pathname === "/claudever9.html") {';
const target = 'if (url.pathname === "/" || url.pathname === "/claudever9.html") {';

if (source.includes(existing)) {
  console.log("/app.html route alias already present.");
  process.exit(0);
}

if (!source.includes(target)) {
  throw new Error("Could not find the StudyQuest HTML route to patch.");
}

fs.writeFileSync(serverPath, source.replace(target, existing));
console.log("Added /app.html route alias.");
