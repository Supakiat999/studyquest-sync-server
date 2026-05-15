const fs = require("node:fs");
const path = require("node:path");

const sourcePath = path.join(__dirname, "..", "..", "studyquest-accounts.json");
const outputPath = path.join(__dirname, "..", "admin-state-export.json");

const accounts = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const admin = accounts.users && accounts.users.admin;

if (!admin || !admin.state) {
  throw new Error("No admin state found in ../studyquest-accounts.json");
}

fs.writeFileSync(outputPath, JSON.stringify(admin.state, null, 2));
console.log(`Exported admin StudyQuest state only: ${outputPath}`);
console.log("Do not export the full studyquest-accounts.json file to hosting.");
