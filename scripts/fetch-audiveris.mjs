// Tải bản phát hành Audiveris mới nhất cho nền tảng đang build và giải nén vào
// apps/desktop/src-tauri/resources/audiveris/ để đóng gói KÈM Holy Melody (người dùng không phải cài riêng).
// Audiveris: AGPL-3.0, phân phối nguyên vẹn như một chương trình riêng; giấy phép + nguồn được ghi kèm.
//
// Dùng: node scripts/fetch-audiveris.mjs <linux|macos-arm64|macos-x64|windows-x64> [thư-mục-đích]
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, cpSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const target = process.argv[2];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = resolve(process.argv[3] ?? join(root, 'apps/desktop/src-tauri/resources/audiveris'));
const REPO = 'Audiveris/audiveris';
const headers = { 'User-Agent': 'holy-melody-build', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

const PATTERNS = {
  linux: [/ubuntu-?24.*x86_64.*\.deb$/i, /ubuntu.*x86_64.*\.deb$/i, /linux.*x86_64.*\.deb$/i],
  'macos-arm64': [/mac.*(arm64|aarch64).*\.dmg$/i],
  'macos-x64': [/mac.*(x86_64|x64|intel).*\.dmg$/i],
  'windows-x64': [/windows.?console.*x86_64.*\.msi$/i, /windows.*x86_64.*\.zip$/i, /windows.*x86_64.*\.msi$/i, /win.*\.msi$/i],
};
if (!PATTERNS[target]) {
  console.error('Nền tảng không hợp lệ:', target);
  process.exit(2);
}

const releases = await (await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers })).json();
const rel = releases.find((r) => !r.draft && !r.prerelease && r.assets?.length);
if (!rel) throw new Error('Không tìm thấy bản phát hành Audiveris');
console.log('Audiveris', rel.tag_name, '– các file:');
for (const a of rel.assets) console.log(`  ${a.name}  ${(a.size / 1e6).toFixed(1)} MB`);
let asset;
for (const re of PATTERNS[target]) {
  asset = rel.assets.find((a) => re.test(a.name));
  if (asset) break;
}
if (!asset) throw new Error(`Không có file Audiveris cho ${target}`);
console.log('Chọn:', asset.name);

const work = join(tmpdir(), `audiveris-${Date.now()}`);
mkdirSync(work, { recursive: true });
const file = join(work, asset.name);
const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] }, redirect: 'follow' });
if (!res.ok) throw new Error(`Tải thất bại ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
console.log('Đã tải', (statSync(file).size / 1e6).toFixed(1), 'MB');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

function findFile(dir, pred, depth = 0) {
  if (depth > 8) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && pred(e.name, p)) return p;
    if (e.isDirectory() && !e.name.endsWith('.app')) {
      const r = findFile(p, pred, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

let exeRel;
if (asset.name.endsWith('.deb')) {
  const x = join(work, 'deb');
  sh('dpkg-deb', ['-x', file, x]);
  const exe = findFile(x, (n) => n === 'Audiveris');
  if (!exe) throw new Error('Không thấy bin/Audiveris trong .deb');
  const appRoot = dirname(dirname(exe)); // .../opt/audiveris
  cpSync(appRoot, dest, { recursive: true, verbatimSymlinks: true });
  exeRel = exe.slice(appRoot.length + 1);
} else if (asset.name.endsWith('.dmg')) {
  const mnt = join(work, 'mnt');
  mkdirSync(mnt);
  sh('hdiutil', ['attach', file, '-nobrowse', '-readonly', '-mountpoint', mnt]);
  try {
    const app = readdirSync(mnt).find((n) => n.endsWith('.app'));
    if (!app) throw new Error('Không thấy .app trong .dmg');
    sh('ditto', [join(mnt, app), join(dest, 'Audiveris.app')]);
    exeRel = join('Audiveris.app', 'Contents', 'MacOS', readdirSync(join(dest, 'Audiveris.app', 'Contents', 'MacOS'))[0]);
  } finally {
    sh('hdiutil', ['detach', mnt, '-quiet']);
  }
} else if (asset.name.endsWith('.msi')) {
  // "administrative install" chỉ giải nén, không ghi registry, không cần quyền quản trị
  const x = join(work, 'msi');
  sh('msiexec', ['/a', file, '/qn', `TARGETDIR=${x}`], { shell: true });
  const exe = findFile(x, (n) => /^audiveris\.exe$/i.test(n));
  if (!exe) throw new Error('Không thấy Audiveris.exe sau khi giải nén .msi');
  const appRoot = dirname(exe);
  cpSync(appRoot, dest, { recursive: true });
  exeRel = 'Audiveris.exe';
} else if (asset.name.endsWith('.zip')) {
  const x = join(work, 'zip');
  mkdirSync(x);
  sh('tar', ['-xf', file, '-C', x]);
  const exe = findFile(x, (n) => /^audiveris(\.exe|\.bat)?$/i.test(n));
  if (!exe) throw new Error('Không thấy Audiveris trong .zip');
  const appRoot = dirname(exe).endsWith('bin') ? dirname(dirname(exe)) : dirname(exe);
  cpSync(appRoot, dest, { recursive: true });
  exeRel = exe.slice(appRoot.length + 1);
}

writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ version: rel.tag_name, asset: asset.name, exe: exeRel.replaceAll('\\', '/') }, null, 2));
writeFileSync(join(dest, 'AUDIVERIS-NOTICE.txt'),
  `Holy Melody đóng gói kèm Audiveris ${rel.tag_name} (https://github.com/${REPO}), phần mềm tự do theo giấy phép GNU AGPL-3.0.\n` +
  `Audiveris được phân phối nguyên vẹn, chạy như một chương trình riêng. Mã nguồn tương ứng: https://github.com/${REPO}/tree/${rel.tag_name}\n` +
  'Toàn văn giấy phép: https://www.gnu.org/licenses/agpl-3.0.txt\n');
console.log('Đã giải nén vào', dest, '→', exeRel);
rmSync(work, { recursive: true, force: true });
