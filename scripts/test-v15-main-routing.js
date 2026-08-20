const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const stable = fs.readFileSync(path.join(root, 'public', 'claudever9.html'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `Missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed ${name}`);
}

const canAccessSource = extractFunction(server, 'canAccessV15');
function canAccess(mode, user) {
  const context = { V15_ACCESS_MODE: mode, ADMIN_USERNAME: 'admin' };
  vm.runInNewContext(`${canAccessSource}\nthis.canAccessV15 = canAccessV15;`, context);
  return context.canAccessV15(user);
}

const admin = { username: 'admin' };
const ordinary = { username: 'anya' };
const deviceToken = { username: 'admin', sync_device_id: 123 };

assert.equal(canAccess('off', admin), false);
assert.equal(canAccess('off', ordinary), false);
assert.equal(canAccess('admin', admin), true);
assert.equal(canAccess('admin', ordinary), false);
assert.equal(canAccess('all', admin), true);
assert.equal(canAccess('all', ordinary), true);
assert.equal(canAccess('all', deviceToken), false);
assert.equal(canAccess('all', null), false);

const rootRouteStart = server.indexOf('if (url.pathname === "/")');
const rootRouteEnd = server.indexOf('if (url.pathname === "/device-recovery.js")', rootRouteStart);
const rootRoute = rootRouteStart >= 0 && rootRouteEnd > rootRouteStart
  ? server.slice(rootRouteStart, rootRouteEnd)
  : '';
assert.ok(rootRoute.includes('if (!user || user.sync_device_id)'), 'root must reject logged-out and device-token requests');
assert.ok(rootRoute.includes('location: "/app.html?next=v15-main"'), 'root must send logged-out users through stable login');
assert.ok(rootRoute.includes('if (!canAccessV15(user))'), 'root must use the fail-closed v15 access gate');
assert.ok(rootRoute.includes('location: "/app.html?stable=1"'), 'root must retain the stable fallback');
assert.ok(rootRoute.includes('authenticatedV15Html(user)'), 'root must serve authenticated v15 HTML');

assert.ok(stable.includes('next === "v15-main"'), 'stable login must recognize the main v15 return path');
assert.ok(stable.includes('window.location.replace("/")'), 'stable login must return authenticated users to the clean root');
assert.ok(stable.includes('next === "v15"'), 'stable login must retain the v15 alias return path');

console.log('v15 main routing and off/admin/all access tests passed.');
