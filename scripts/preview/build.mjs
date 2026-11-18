// Build bản preview của giao diện desktop bằng esbuild + Tailwind v4 (không cần Vite/npm install).
import { build } from '/opt/npm-tools/node_modules/esbuild/lib/main.js';
import { compile } from '/opt/npm-tools/node_modules/tailwindcss/dist/lib.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(process.argv[2] ?? join(here, 'dist'));
const entry = process.argv[3] ?? join(root, 'apps/desktop/src/main.tsx');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile: join(out, 'app.js'),
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  nodePaths: ['/opt/npm-tools/node_modules'],
  alias: {
    zustand: join(here, 'zustand-shim.js'),
    '@holy-melody/music-core': join(root, 'packages/music-core/src/index.ts'),
    '@holy-melody/midi-engine': join(root, 'packages/midi-engine/src/index.ts'),
    '@holy-melody/score-renderer': join(root, 'packages/score-renderer/src/index.ts'),
    '@tauri-apps/api/event': join(here, 'tauri-event-stub.js'),
    'react-dom/server': '/opt/npm-tools/node_modules/react-dom/server.browser.js',
    'pdfjs-dist/build/pdf.worker.min.mjs?url': join(here, 'pdf-worker-url.js'),
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: false,
  logLevel: 'warning',
});

// Tailwind: tự gom các class từ mã nguồn
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.(tsx?|ts)$/.test(f) && files.push(p); });
walk(join(root, 'apps/desktop/src'));
const candidates = new Set();
for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/[^\s"'`{};<>]+/g)) candidates.add(m[0]);
const tw = await compile(readFileSync(join(root, 'apps/desktop/src/styles.css'), 'utf8'), {
  base: '/opt/npm-tools/node_modules/tailwindcss',
  loadStylesheet: async (id, base) => {
    const p = id === 'tailwindcss' ? '/opt/npm-tools/node_modules/tailwindcss/index.css' : resolve(base, id);
    return { path: p, base: dirname(p), content: readFileSync(p, 'utf8') };
  },
});
writeFileSync(join(out, 'app.css'), tw.build([...candidates]));
mkdirSync(join(out, 'pdfjs-dist/build'), { recursive: true });
writeFileSync(join(out, 'pdfjs-dist/build/pdf.worker.min.mjs'), readFileSync('/opt/npm-tools/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'));
for (const d of ['wasm', 'standard_fonts', 'cmaps', 'iccs']) cpSync(join('/opt/npm-tools/node_modules/pdfjs-dist', d), join(out, 'pdfjs', d), { recursive: true });
cpSync(join(here, '../../apps/desktop/public'), out, { recursive: true });
writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Holy Melody</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`);
console.log('preview built →', out);
