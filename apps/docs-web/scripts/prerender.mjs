// Writes one static HTML file per page from the server build, so every page
// reads without JavaScript; the browser bundle then hydrates it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const ssrDir = path.join(root, 'dist-ssr');
const { render, ROUTES } = await import(path.join(ssrDir, 'entry-server.js'));
const template = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
for (const r of ROUTES) {
  const url = 'https://docs.daemonclient.uz' + (r.path === '/404' ? '/' : r.path);
  const head = [
    `<title>${esc(r.tab)}</title>`,
    `<meta name="description" content="${esc(r.desc)}">`,
    r.path === '/404' ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${url}">`,
    `<meta property="og:title" content="${esc(r.tab)}">`,
    `<meta property="og:description" content="${esc(r.desc)}">`,
    `<meta property="og:type" content="website">`,
  ].join('\n');
  // Functions, not strings: a `$` in page text must not be read as a replace pattern.
  const html = template
    .replace('<!--app-head-->', () => head)
    .replace('<div id="root"><!--app-html--></div>', () => `<div id="root" data-route="${r.path}">${render(r.path)}</div>`);
  if (!html.includes(`data-route="${r.path}"`)) throw new Error(`template has no root for ${r.file}`);
  fs.writeFileSync(path.join(dist, r.file), html);
}
fs.rmSync(ssrDir, { recursive: true, force: true });
console.log(`prerendered ${ROUTES.length} pages`);
