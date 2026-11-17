import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// pdf.js cần các file phụ khi chạy: wasm (giải mã ảnh JBIG2/JPEG2000 trong PDF quét), font chuẩn, cmaps
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const pdfjsAssets = () => ({
  name: 'holy-melody-pdfjs-assets',
  writeBundle(opts: { dir?: string }) {
    for (const d of ['wasm', 'standard_fonts', 'cmaps', 'iccs']) {
      const src = join(pdfjsRoot, d);
      if (existsSync(src)) cpSync(src, join(opts.dir ?? 'dist', 'pdfjs', d), { recursive: true });
    }
  },
  configureServer(server: { middlewares: { use: (p: string, h: (req: { url?: string }, res: { end: (b: Buffer) => void; setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use('/pdfjs/', (req, res, next) => {
      const f = join(pdfjsRoot, (req.url ?? '').split('?')[0]!);
      if (!existsSync(f)) return next();
      if (f.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
      res.end(readFileSync(f));
    });
  },
});

// Tauri dùng cổng cố định; không xóa màn hình để thấy lỗi Rust
export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
});
