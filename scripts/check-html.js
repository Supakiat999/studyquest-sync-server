const fs = require('node:fs');

const files = process.argv.slice(2);
if (!files.length) throw new Error('Provide one or more HTML files.');

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let count = 0;
  for (const match of html.matchAll(pattern)) {
    count += 1;
    try { new Function(match[1]); }
    catch (error) { throw new Error(`${file} inline script ${count}: ${error.message}`); }
  }
  if (!count) throw new Error(`${file} has no inline scripts.`);
  console.log(`${file}: ${count} inline scripts parsed`);
}
