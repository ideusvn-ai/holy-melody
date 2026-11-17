// Tải SoundFont GeneralUser GS (giấy phép cho phép dùng trong phần mềm) vào apps/desktop/src-tauri/resources/
// Dùng: node scripts/fetch-soundfont.mjs
import { createHash } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'apps/desktop/src-tauri/resources');
const target = join(dir, 'GeneralUser-GS.sf2');
const REPO = 'mrbumpy409/GeneralUser-GS';

if (existsSync(target) && statSync(target).size > 10_000_000) {
  console.log('SoundFont đã có:', target);
  process.exit(0);
}

const headers = { 'User-Agent': 'holy-melody-build', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

async function get(url) {
  const r = await fetch(url, { headers, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

// Tìm đường dẫn .sf2 và LICENSE trong repo gốc bằng GitHub API (không phụ thuộc tên file cố định)
const repo = await (await get(`https://api.github.com/repos/${REPO}`)).json();
const branch = repo.default_branch ?? 'main';
const tree = await (await get(`https://api.github.com/repos/${REPO}/git/trees/${branch}?recursive=1`)).json();
const sf2 = tree.tree.filter((t) => t.type === 'blob' && /\.sf2$/i.test(t.path)).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
if (!sf2) throw new Error('Không tìm thấy file .sf2 trong ' + REPO);
const lic = tree.tree.find((t) => t.type === 'blob' && /^(LICENSE|documentation\/LICENSE)[^/]*$/i.test(t.path)) ?? tree.tree.find((t) => /license/i.test(t.path) && t.type === 'blob');

const raw = (p) => `https://raw.githubusercontent.com/${REPO}/${branch}/${p.split('/').map(encodeURIComponent).join('/')}`;
console.log('Tải', sf2.path, `${((sf2.size ?? 0) / 1e6).toFixed(1)} MB`);
let buf = Buffer.from(await (await get(raw(sf2.path))).arrayBuffer());
// Repo có thể dùng Git LFS: khi đó raw trả về file con trỏ → tải qua media.githubusercontent.com
if (buf.length < 1_000_000 && buf.toString('utf8', 0, 40).includes('git-lfs')) {
  buf = Buffer.from(await (await get(`https://media.githubusercontent.com/media/${REPO}/${branch}/${sf2.path.split('/').map(encodeURIComponent).join('/')}`)).arrayBuffer());
}
if (buf.length < 5_000_000 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'sfbk') {
  throw new Error(`File tải về không phải SoundFont hợp lệ (${buf.length} byte)`);
}
writeFileSync(target, buf);
console.log('Đã lưu', target, 'sha256', createHash('sha256').update(buf).digest('hex'));
if (lic) {
  const t = await (await get(raw(lic.path))).text();
  writeFileSync(join(dir, 'GeneralUser-GS-LICENSE.txt'), t);
  console.log('Giấy phép:', lic.path);
}
