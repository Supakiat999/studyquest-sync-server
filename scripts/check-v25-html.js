// Existing syntax checker, now applied to both directly derived v25 pages.
process.argv=['node','check-html.js','public/claudever25.html','../claudever25.html'];
require('./check-html.js');
