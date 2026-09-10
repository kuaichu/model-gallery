const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appPath = path.join(root, 'frontend/app.js');
const htmlPath = path.join(root, 'frontend/index.html');
const cssPath = path.join(root, 'frontend/style.css');
const app = fs.readFileSync(appPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`) >= 0
    ? source.indexOf(`async function ${name}(`)
    : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const signatureEnd = source.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `${name} should have a body`);
  const brace = signatureEnd + 2;
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('request adds the session Bearer token and JSON content type', async () => {
  const calls = [];
  const context = {
    Headers,
    authToken: 'session-token',
    backendUrl: value => `http://gallery.test${value}`,
    handleUnauthorized: async () => {},
    fetch: async (url, options) => {
      calls.push({url, options});
      return {ok:true, status:200, json:async () => ({ok:true})};
    }
  };
  vm.runInNewContext(`${extractFunction(app, 'request')}; this.request = request;`, context);
  await context.request('/api/projects', {method:'POST', body:'{}'});
  assert.equal(calls[0].options.headers.get('Authorization'), 'Bearer session-token');
  assert.equal(calls[0].options.headers.get('Content-Type'), 'application/json');
  assert.equal(calls[0].url, 'http://gallery.test/api/projects');
});

test('request handles 401 before rejecting and can suppress the public refresh', async () => {
  const unauthorized = [];
  const context = {
    Headers,
    authToken: 'expired',
    backendUrl: value => value,
    handleUnauthorized: async refresh => unauthorized.push(refresh),
    fetch: async () => ({ok:false, status:401, json:async () => ({error:'expired'})})
  };
  vm.runInNewContext(`${extractFunction(app, 'request')}; this.request = request;`, context);
  await assert.rejects(context.request('/api/auth/session', {}, {refreshOn401:false}), /expired/);
  assert.deepEqual(unauthorized, [false]);
});

test('an authenticated library 401 retries once as a guest', async () => {
  let calls = 0;
  const context = {
    Headers,
    authToken: 'expired',
    backendUrl: value => value,
    handleUnauthorized: async () => { context.authToken = ''; },
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? {ok:false, status:401, json:async () => ({error:'expired'})}
        : {ok:true, status:200, json:async () => ({projects:[]})};
    }
  };
  vm.runInNewContext(`${extractFunction(app, 'request')}; this.request = request;`, context);
  const result = await context.request('/api/library');
  assert.equal(calls, 2);
  assert.deepEqual(result.projects, []);
});

test('guest UI starts hidden and management actions carry admin markers', () => {
  assert.match(html, /<html[^>]+class="is-guest"/);
  assert.match(css, /html:not\(\.is-admin\) \[data-admin-only\] \{ display: none !important; \}/);
  for (const selector of ['id="export-library" data-admin-only', 'data-open-project data-admin-only', 'data-open-group data-admin-only', 'id="edit-group" data-admin-only']) {
    assert.ok(html.includes(selector), `${selector} should be admin-only`);
  }
  assert.match(app, /data-admin-only data-drag-id=/);
  assert.match(app, /data-admin-only data-edit-project=/);
  assert.match(app, /data-admin-only data-delete-project=/);
});

test('write paths and drag handlers have local permission guards', () => {
  for (const name of ['openGroupDialog', 'openProjectDialog', 'saveGroup', 'saveProject', 'deleteProject', 'exportLibrary', 'moveProject']) {
    assert.match(extractFunction(app, name), /requireAdmin\(\)/, `${name} should require admin`);
  }
  assert.match(app, /pointerdown[\s\S]*?if \(!state\.authenticated\) return;/);
  assert.match(app, /keydown[\s\S]*?if \(!state\.authenticated\) return;/);
  assert.match(app, /return state\.authenticated \? openProjectDialog\(project\) : openComparison\(project\)/);
});

test('private source changes do not invalidate existing preview cards', () => {
  assert.match(extractFunction(app, 'renderProjects'), /const \{ displayOrder, source, \.\.\.content \} = project;/);
});

test('logout sends a JSON body and does not claim revocation after network failure', () => {
  assert.match(app, /request\('\/api\/auth\/logout', \{method:'POST', body:'\{\}'\}/);
  assert.match(app, /退出失败，服务端会话尚未撤销/);
});

test('auth expiry and cancelled login invalidate stale admin responses', () => {
  assert.match(app, /scheduleAuthExpiry\(result\.expiresAt\)/);
  assert.match(app, /scheduleAuthExpiry\(session\.expiresAt\)/);
  assert.match(app, /const attempt = \+\+loginAttempt/);
  assert.match(app, /if \(loginAttempt !== attempt\) return;/);
  assert.match(app, /elements\.loginDialog\.addEventListener\('close', \(\) => \{\s*loginAttempt \+= 1;/);
});

test('expiry callback clears admin state and reloads the public library', async () => {
  let callback;
  const events = [];
  const context = {
    authExpiryTimer: null,
    state: {authenticated:true, authExpiresAt:0},
    Date: {now:() => 10_000},
    clearTimeout:() => {},
    setTimeout:fn => { callback = fn; return 1; },
    setAuthState:value => { context.state.authenticated = value; events.push(`auth:${value}`); },
    loadLibrary:async () => { events.push('library'); },
    showToast:value => { events.push(value); }
  };
  vm.runInNewContext(`${extractFunction(app, 'scheduleAuthExpiry')}; this.scheduleAuthExpiry = scheduleAuthExpiry;`, context);
  context.scheduleAuthExpiry(10);
  await callback();
  assert.deepEqual(events, ['auth:false', 'library', '登录已过期，请重新登录。']);
});
