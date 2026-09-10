import {mkdir, readdir, copyFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const files = ['index.html', 'app.js', 'style.css', 'theme.js'];
let api;
try {
  api = new URL(process.env.GALLERY_API_BASE_URL || '');
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) throw new Error();
} catch {
  throw new Error('Set GALLERY_API_BASE_URL to the public HTTPS API base URL (optional path prefix; no credentials, query or fragment).');
}

await mkdir(output, {recursive:true});
const allowed = new Set([...files, 'config.js']);
for (const item of await readdir(output)) {
  if (!allowed.has(item)) throw new Error('dist contains unexpected files. Use an empty build output directory.');
}
for (const name of files) await copyFile(resolve(root, 'frontend', name), resolve(output, name));
const apiBaseUrl = api.href.replace(/\/+$/, '');
await writeFile(resolve(output, 'config.js'), `window.GALLERY_CONFIG = ${JSON.stringify({apiBaseUrl})};\n`, 'utf8');
console.log('Cloudflare Pages frontend built: dist (5 static files, no backend or runtime data).');
