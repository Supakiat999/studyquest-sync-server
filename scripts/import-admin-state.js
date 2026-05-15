const fs = require("node:fs");
const path = require("node:path");

const hostedUrl = process.env.STUDYQUEST_HOSTED_URL;
const adminPassword = process.env.STUDYQUEST_ADMIN_PASSWORD;
const statePath = process.env.STUDYQUEST_STATE_FILE || path.join(__dirname, "..", "admin-state-export.json");

if (!hostedUrl) throw new Error("Set STUDYQUEST_HOSTED_URL to your Render StudyQuest URL.");
if (!adminPassword) throw new Error("Set STUDYQUEST_ADMIN_PASSWORD to the hosted admin password.");

function endpoint(route) {
  const url = new URL(hostedUrl);
  url.pathname = route;
  url.search = "";
  return url.toString();
}

async function main() {
  const login = await fetch(endpoint("/api/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: adminPassword })
  });

  if (!login.ok) throw new Error(`Admin login failed: HTTP ${login.status}`);
  const cookie = login.headers.get("set-cookie");
  if (!cookie) throw new Error("Hosted server did not return a session cookie.");

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const save = await fetch(endpoint("/api/state"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie
    },
    body: JSON.stringify(state)
  });

  if (!save.ok) throw new Error(`State import failed: HTTP ${save.status} ${await save.text()}`);
  console.log("Imported admin state into hosted StudyQuest.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
