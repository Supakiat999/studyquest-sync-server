const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

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

const canAccessSource = extractFunction(server, 'canAccessV16');
function canAccess(mode, user) {
  const context = { V16_ACCESS_MODE: mode, ADMIN_USERNAME: 'admin' };
  vm.runInNewContext(`${canAccessSource}\nthis.canAccessV16 = canAccessV16;`, context);
  return context.canAccessV16(user);
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

const routeStart = server.indexOf('if (url.pathname === "/v16"');
const routeEnd = server.indexOf('if (url.pathname === "/")', routeStart);
const route = routeStart >= 0 && routeEnd > routeStart ? server.slice(routeStart, routeEnd) : '';
assert.ok(route.includes('url.pathname === "/claudever16.html"'));
assert.ok(route.includes('location: "/app.html?next=v16"'));
assert.ok(route.includes('location: "/app.html?stable=1"'));
assert.ok(route.includes('authenticatedV16Html(user)'));

assert.ok(server.includes('requestedVersion === "16"'));
assert.ok(server.includes('V16_VERSION_PATH'));
assert.ok(server.includes('v16AccessMode: V16_ACCESS_MODE'));

console.log('v16 hosted access and route matrix passed.');
