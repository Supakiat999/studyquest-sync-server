const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const criteria = require('../lib/v18-admin-course-criteria');

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

const canAccessSource = extractFunction(server, 'canAccessV19');
function canAccess(mode, user) {
  const context = { V19_ACCESS_MODE: mode, ADMIN_USERNAME: 'admin' };
  vm.runInNewContext(`${canAccessSource}\nthis.canAccessV19 = canAccessV19;`, context);
  return context.canAccessV19(user);
}

const admin = { username:'admin' };
const ordinary = { username:'anya' };
const deviceToken = { username:'admin', sync_device_id:123 };
assert.equal(canAccess('off', admin), false);
assert.equal(canAccess('off', ordinary), false);
assert.equal(canAccess('admin', admin), true);
assert.equal(canAccess('admin', ordinary), false);
assert.equal(canAccess('all', admin), true);
assert.equal(canAccess('all', ordinary), true);
assert.equal(canAccess('all', deviceToken), false);
assert.equal(canAccess('all', null), false);

const routeStart = server.indexOf('if (url.pathname === "/v19"');
const routeEnd = server.indexOf('if (url.pathname === "/")', routeStart);
const route = routeStart >= 0 && routeEnd > routeStart ? server.slice(routeStart, routeEnd) : '';
assert.ok(route.includes('url.pathname === "/claudever19.html"'));
assert.ok(route.includes('if (!user || user.sync_device_id)'));
assert.ok(route.includes('if (!canAccessV19(user))'));
assert.ok(route.includes('authenticatedV19Html(user)'));
assert.ok(route.includes('location: "/app.html?stable=1"'));

assert.ok(server.includes('requestedVersion === "19"'));
assert.ok(server.includes('V19_VERSION_PATH'));
assert.ok(server.includes('v19AccessMode: V19_ACCESS_MODE'));

assert.equal(criteria.entries.length, 7);
assert.equal(criteria.entries.some(entry => /advanced math/i.test(entry.courseName)), false);
for (const entry of criteria.entries) {
  if (entry.scoreBreakdown.length) {
    assert.equal(entry.scoreBreakdown.reduce((sum, item) => sum + item.weightPct, 0), 100, `${entry.courseName} weights`);
  }
}

console.log('v19 hosted access, route, and admin criteria checks passed.');
