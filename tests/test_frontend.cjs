const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const calls = [];
const context = {
  Headers, authToken: '',
  window: {GALLERY_CONFIG:{apiBaseUrl:'http://127.0.0.1:8766/'}}, URL,
  fetch: async (url, options) => {
    calls.push({url, options});
    return {ok:true, json:async()=>({saved:true})};
  },
  state:{selected:new Set()},
  escapeHTML:value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;'),
  completionText:()=> '1 分 0 秒', rating:()=> '未评分'
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  const apiBase ='),source.indexOf('  const $ =')),context);
vm.runInContext(source.slice(source.indexOf('  async function request('),source.indexOf('  async function loadLibrary(')),context);
vm.runInContext(source.slice(source.indexOf('  function projectCard('),source.indexOf('  function renderProjects(')),context);
(async () => {
  const project = {id:'test', title:'作品', previewUrl:'/projects/example/index.html?view=top#scene'};
  assert.equal(context.projectUrl(project), 'http://127.0.0.1:8766/projects/example/index.html?view=top#scene');
  assert.equal(context.projectUrl(project,true), 'http://127.0.0.1:8766/projects/example/index.html?view=top&split=1#scene');
  assert.equal(context.projectUrl({entry:'/projects/fallback/index.html'}), 'http://127.0.0.1:8766/projects/fallback/index.html');
  for (const url of ['https://example.com/scene?x=1', 'http://localhost:3000/demo']) {
    assert.equal(context.projectUrl({previewUrl:url},true),url);
  }
  assert.equal(context.projectUrl({}), '');
  const html=context.projectCard(project,0);
  assert(html.includes('data-preview-src="http://127.0.0.1:8766/projects/example/index.html?view=top#scene"'));
  assert(html.includes('href="http://127.0.0.1:8766/projects/example/index.html?view=top#scene"'));
  const before=JSON.stringify(project);
  context.projectUrl(project,true);
  assert.equal(JSON.stringify(project),before, 'URL conversion must not mutate persisted project fields');
  await context.request('/api/library');
  await context.request('/api/projects/test',{method:'PATCH',body:JSON.stringify({notes:'edit'})});
  assert.equal(calls[0].url,'http://127.0.0.1:8766/api/library');
  assert.equal(calls[1].url,'http://127.0.0.1:8766/api/projects/test');
  assert.equal(calls[1].options.headers.get('Content-Type'),'application/json');
  const custom={window:{GALLERY_CONFIG:{apiBaseUrl:'https://api.example.test'}},URL};
  vm.createContext(custom);
  vm.runInContext(source.slice(source.indexOf('  const apiBase ='),source.indexOf('  const $ =')),custom);
  assert.equal(custom.projectUrl(project,true),'https://api.example.test/projects/example/index.html?view=top&split=1#scene');
  console.log('PASS: configurable API requests, card/open/split URLs, external URL preservation, immutable records');
})().catch(error=>{console.error(error);process.exitCode=1;});
