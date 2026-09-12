const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const publicRoot = path.join(__dirname, '..', 'public');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function safePublicPath(urlPath) {
  const relative = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const candidate = path.resolve(publicRoot, relative);
  if (candidate !== publicRoot && !candidate.startsWith(`${publicRoot}${path.sep}`)) return null;
  return candidate;
}

async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/live-state') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const requested = url.pathname === '/' ? '/claudever22.html' : url.pathname;
    const filePath = safePublicPath(requested);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    let body = fs.readFileSync(filePath);
    if (path.basename(filePath) === 'claudever22.html') {
      body = Buffer.from(body.toString('utf8').replace('</head>', '<script>window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__={username:"qa-browser"};</script></head>'));
    }
    response.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/claudever22.html`;
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 520, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      page.on('pageerror', error => errors.push(`${viewport.width}: ${error.message}`));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      assert.match(await page.title(), /StudyQuest v22/);
      assert.equal(await page.evaluate(() => typeof window.StudyQuestV22AccountSync?.install === 'function'), true);
      assert.equal(await page.evaluate(() => typeof window.StudyQuestV22Subtasks?.install === 'function'), true);
      assert.equal(await page.evaluate(() => !!window.StudyQuestV22SubtaskStore), true);
      assert.equal(await page.evaluate(() => !!document.querySelector('script[src*="v22-account-sync.js"]')), true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow < 80, `${viewport.width}px layout overflowed by ${overflow}px`);
      await page.close();
    }
    assert.deepEqual(errors, [], 'v22 browser boot should not raise page errors');
    console.log('v22 hosted browser boot and desktop/520px layout checks passed.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
