const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'theme.js'), 'utf8');

function loadTheme({ stored = null, systemDark = false, storageFails = false, readyState = 'loading' } = {}) {
  const root = new Map();
  const buttonAttributes = new Map([['aria-pressed', 'false']]);
  const listeners = {};
  const mediaListeners = [];
  const writes = [];
  const button = {
    textContent: '暗色模式',
    setAttribute(name, value) { buttonAttributes.set(name, value); },
    addEventListener(type, listener) { listeners[`button:${type}`] = listener; }
  };
  const document = {
    readyState,
    documentElement: {
      setAttribute(name, value) { root.set(name, value); },
      getAttribute(name) { return root.get(name) || null; }
    },
    getElementById(id) { return id === 'theme-toggle' ? button : null; },
    addEventListener(type, listener) { listeners[`document:${type}`] = listener; }
  };
  const media = {
    matches: systemDark,
    addEventListener(type, listener) { if (type === 'change') mediaListeners.push(listener); }
  };
  const localStorage = {
    getItem() { if (storageFails) throw new Error('blocked'); return stored; },
    setItem(key, value) { if (storageFails) throw new Error('blocked'); writes.push([key, value]); }
  };
  vm.runInNewContext(source, { window: { matchMedia: () => media, localStorage }, document });
  return {
    theme: () => root.get('data-theme'),
    pressed: () => buttonAttributes.get('aria-pressed'),
    label: () => button.textContent,
    ready: () => listeners['document:DOMContentLoaded']?.(),
    click: () => listeners['button:click'](),
    system: matches => mediaListeners.forEach(listener => listener({ matches })),
    writes
  };
}

{
  const page = loadTheme({ stored: 'dark', systemDark: false });
  assert.equal(page.theme(), 'dark', 'saved theme applies before DOM ready');
  page.ready();
  assert.equal(page.pressed(), 'true');
  assert.equal(page.label(), '切换到浅色模式');
  page.click();
  assert.equal(page.theme(), 'light');
  assert.deepEqual(page.writes, [['gallery-theme', 'light']]);
  page.system(true);
  assert.equal(page.theme(), 'light', 'system changes do not override an explicit choice');
}

{
  const page = loadTheme({ systemDark: false, readyState: 'complete' });
  assert.equal(page.theme(), 'light');
  page.system(true);
  assert.equal(page.theme(), 'dark', 'theme follows the system before an explicit choice');
  assert.equal(page.pressed(), 'true');
}

{
  const page = loadTheme({ systemDark: true, storageFails: true, readyState: 'complete' });
  assert.equal(page.theme(), 'dark');
  page.click();
  assert.equal(page.theme(), 'light', 'toggle remains usable when storage is blocked');
  page.system(true);
  assert.equal(page.theme(), 'light', 'in-memory choice remains authoritative');
}

console.log('theme behavior tests passed');
