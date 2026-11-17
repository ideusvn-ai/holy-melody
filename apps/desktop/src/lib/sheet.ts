/**
 * Bản nhạc mở từ ảnh/PDF.
 *  - Player: hiển thị TRANG GỐC (PDF vẽ dạng vector bằng pdf.js theo mức zoom; ảnh hiển thị trực tiếp) và một
 *    lớp phủ lấy từ MusicXML của Audiveris để phát MIDI + tô sáng. Chưa dựng khuông nhạc.
 *  - "Chuyển sang Edit" (10 credit, một lần cho mỗi file gốc): Validator → nhận dạng lại các vùng lỗi → dựng khuông
 *    nhạc đầy đủ → người dùng đối chiếu từng ô với ảnh gốc, kết quả + tọa độ lưu vĩnh viễn trong dự án.
 */
import {
  applyMissedKey, autoFixIssues, difficulty, enterEditMode, extractOmrGeometry, extractOmrSignals, reviewIssues, type OmrSignal, type SheetMeasureGeom, extractSheetGeometry, readZip, importMusicXml, markAllUnverified, readMxl,
  regionOf, replaceMeasuresFrom, validateMusic, type RuleIssue, type ScoreDocument, type SheetBox, type SheetSource,
} from '@holy-melody/music-core';
import { tauriInvoke } from './fileio';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// ------------------------------------------------------------------ file gốc (không nằm trong lịch sử Undo)

export interface SheetAsset {
  kind: 'image' | 'pdf';
  bytes: Uint8Array;
  mime: string;
  url?: string;
  pdf?: Promise<PdfDoc>;
}
const assets = new Map<string, SheetAsset>();
export const getSheetAsset = (scoreId: string) => assets.get(scoreId);
export function setSheetAsset(scoreId: string, a: SheetAsset) {
  assets.set(scoreId, a);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ pdf.js (tải khi cần)

interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

async function pdfjs() {
  const lib = (await import('pdfjs-dist')) as unknown as {
    getDocument(o: { data: Uint8Array; [k: string]: unknown }): { promise: Promise<PdfDoc> };
    GlobalWorkerOptions: { workerSrc: string };
  };
  // gán luôn: pdf.js có giá trị mặc định không đúng với cách đóng gói của ứng dụng
  lib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return lib;
}

export function pdfOf(a: SheetAsset): Promise<PdfDoc> {
  // pdf.js chiếm bộ đệm nên truyền bản sao
  const base = new URL('pdfjs/', location.href).toString();
  a.pdf ??= pdfjs().then((lib) => lib.getDocument({
    data: a.bytes.slice(), wasmUrl: `${base}wasm/`, standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, iccUrl: `${base}iccs/`,
  }).promise);
  return a.pdf;
}

export function imageUrl(a: SheetAsset): string {
  a.url ??= URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime }));
  return a.url;
}

/** Vẽ trang PDF (vector) vào canvas với chiều rộng CSS `cssWidth` — sắc nét ở mọi mức zoom */
export async function renderPdfPage(a: SheetAsset, page: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void> {
  const doc = await pdfOf(a);
  const p = await doc.getPage(page + 1);
  const base = p.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const vp = p.getViewport({ scale: (cssWidth / base.width) * dpr });
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.render({ canvasContext: ctx, viewport: vp }).promise;
}

/** Ảnh điểm của một trang ở độ rộng `pxWidth` (dùng để cắt vùng nhận dạng lại / đối chiếu) */
async function pageRaster(a: SheetAsset, page: number, pxWidth: number): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  if (a.kind === 'pdf') {
    const doc = await pdfOf(a);
    const p = await doc.getPage(page + 1);
    const vp = p.getViewport({ scale: pxWidth / p.getViewport({ scale: 1 }).width });
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }
  const img = await createImageBitmap(new Blob([a.bytes as BlobPart], { type: a.mime }));
  const s = pxWidth / img.width;
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export interface CropConfig {
  id: string;
  /** chiều rộng trang khi cắt (px): càng lớn càng phóng to */
  pageWidth: number;
  /** ngưỡng nhị phân hoá 0..255 (bỏ trống = giữ thang xám) */
  threshold?: number;
}

/** Hai cấu hình khác với lần chạy cả trang: phóng to + làm rõ nét, phóng to hơn + nhị phân hoá */
export const REGION_CONFIGS: CropConfig[] = [
  { id: 'x2-gray', pageWidth: 4800 },
  { id: 'x3-bin', pageWidth: 7200, threshold: 170 },
];

/** Cắt vùng `box` của trang thành PNG (đã xử lý theo cấu hình) */
export async function cropPng(a: SheetAsset, box: SheetBox, cfg: CropConfig): Promise<Uint8Array> {
  const src = await pageRaster(a, box.page, cfg.pageWidth);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(box.w * src.width));
  c.height = Math.max(1, Math.round(box.h * src.height));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, Math.round(box.x * src.width), Math.round(box.y * src.height), c.width, c.height, 0, 0, c.width, c.height);
  if (cfg.threshold !== undefined) {
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = 0.299 * d.data[i]! + 0.587 * d.data[i + 1]! + 0.114 * d.data[i + 2]! < cfg.threshold ? 0 : 255;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      d.data[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
  }
  const blob = await new Promise<Blob>((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('Không tạo được ảnh vùng'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** URL ảnh vùng để người dùng đối chiếu (đã cache) */
const cropCache = new Map<string, string>();
export async function cropUrl(scoreId: string, a: SheetAsset, box: SheetBox): Promise<string> {
  const k = `${scoreId}:${box.page}:${box.x.toFixed(4)}:${box.y.toFixed(4)}:${box.w.toFixed(4)}:${box.h.toFixed(4)}`;
  const hit = cropCache.get(k);
  if (hit) return hit;
  const png = await cropPng(a, box, { id: 'view', pageWidth: 2400 });
  const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
  cropCache.set(k, url);
  return url;
}

// ------------------------------------------------------------------ Audiveris

type Listen = (event: string, cb: (e: { payload: { stage: number; line: string } }) => void) => Promise<() => void>;

/** Chạy Audiveris trên một file, trả về MusicXML (chuỗi) */
export async function runAudiveris(
  name: string, bytes: Uint8Array, opts: { job?: string; options?: string[]; onProgress?: (stage: number, line: string) => void } = {},
): Promise<string> {
  return (await runAudiverisFull(name, bytes, opts)).xml;
}

/** Như runAudiveris, kèm XML từng trang trong dự án .omr (tọa độ pixel chính xác) */
export async function runAudiverisFull(
  name: string, bytes: Uint8Array, opts: { job?: string; options?: string[]; onProgress?: (stage: number, line: string) => void } = {},
): Promise<{ xml: string; sheets: string[]; binaries: (Uint8Array | undefined)[] }> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('Nhận dạng ảnh/PDF cần chạy trong ứng dụng desktop.');
  let unlisten: (() => void) | undefined;
  try {
    if (opts.onProgress) {
      const { listen } = (await import('@tauri-apps/api/event')) as unknown as { listen: Listen };
      unlisten = await listen('omr://progress', (e) => opts.onProgress!(e.payload.stage, e.payload.line));
    }
    const path = (await invoke('omr_temp_input', { name })) as string;
    await invoke('write_file', { path, contents: Array.from(bytes) });
    const out = (await invoke('omr_run', { input: path, options: opts.options ?? null, job: opts.job ?? null })) as { mxlPath: string; omrPath?: string | null };
    const mxl = new Uint8Array((await invoke('read_file', { path: out.mxlPath })) as number[]);
    const xml = await readMxl(mxl);
    const sheets: string[] = [];
    const binaries: (Uint8Array | undefined)[] = [];
    if (out.omrPath) {
      try {
        const files = await readZip(new Uint8Array((await invoke('read_file', { path: out.omrPath })) as number[]));
        const dec = new TextDecoder();
        const names = [...files.keys()].filter((n) => /^sheet#\d+\/sheet#\d+\.xml$/.test(n)).sort((a, b) => Number(/#(\d+)/.exec(a)![1]) - Number(/#(\d+)/.exec(b)![1]));
        for (const n of names) {
          sheets.push(dec.decode(files.get(n)!));
          binaries.push(files.get(n.replace(/[^/]+$/, 'BINARY.png')));
        }
      } catch {
        /* không đọc được .omr: dùng tọa độ trong MusicXML */
      }
    }
    return { xml, sheets, binaries };
  } finally {
    unlisten?.();
  }
}

/** Mở ảnh/PDF: nhận dạng bằng Audiveris và tạo bản nhạc ở chế độ "lớp phủ" (chỉ để phát) */
export async function openSheet(file: File, onProgress?: (stage: number, line: string) => void): Promise<ScoreDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind: 'image' | 'pdf' = /\.pdf$/i.test(file.name) ? 'pdf' : 'image';
  const asset: SheetAsset = { kind, bytes, mime: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/png') };
  const [hash, { xml, sheets, binaries }] = await Promise.all([sha256Hex(bytes), runAudiverisFull(file.name, bytes, { onProgress })]);
  const score = importMusicXml(xml);
  if (!score.meta.title || score.meta.title === 'Untitled') score.meta.title = file.name.replace(/\.[^.]+$/, '');
  markAllUnverified(score);

  // kích thước trang thật
  const pages: SheetSource['pages'] = [];
  if (kind === 'pdf') {
    const doc = await pdfOf(asset);
    for (let i = 0; i < doc.numPages; i++) {
      const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      pages.push({ file: 'source.pdf', width: vp.width, height: vp.height });
    }
  } else {
    const img = await createImageBitmap(new Blob([bytes as BlobPart], { type: asset.mime })).catch(() => null);
    pages.push({ file: `source.${file.name.split('.').pop()?.toLowerCase() ?? 'png'}`, width: img?.width ?? 0, height: img?.height ?? 0 });
  }
  // ưu tiên tọa độ pixel trong .omr; chỉ dùng khi số ô nhịp khớp với bản nhạc
  const omrGeom = sheets.length ? extractOmrGeometry(sheets) : null;
  const measures = omrGeom && omrGeom.length === score.measures.length ? omrGeom : (extractSheetGeometry(xml)?.measures ?? []);
  score.sheet = { kind, fileName: file.name, hash, pages, measures, mode: 'overlay', reviews: {} };
  if (omrGeom && measures === omrGeom) score.sheet.signals = await detectHardRegions(sheets, binaries, omrGeom).catch(() => []);
  setSheetAsset(score.id, asset);
  return score;
}

// ------------------------------------------------------------------ phát hiện vùng khó

/**
 * Vùng khó: (1) ô có điểm tin cậy thấp theo bộ phân loại của Audiveris; (2) đầu dòng nhạc có mực giữa khoá nhạc và
 * số chỉ nhịp nhưng Audiveris không nhận ra hoá biểu (đo trên ảnh nhị phân của Audiveris, bỏ các dòng kẻ).
 */
export async function detectHardRegions(sheets: string[], binaries: (Uint8Array | undefined)[], geom: SheetMeasureGeom[]): Promise<OmrSignal[]> {
  const sig = extractOmrSignals(sheets, geom);
  const out: OmrSignal[] = [];
  for (const g of sig.grades) {
    if (g.count >= 2 && (g.mean < 0.6 || g.min < 0.35)) {
      out.push({ measureIndex: g.measureIndex, code: 'LOW_GRADE', message: `Audiveris không chắc khi đọc ô này (độ tin cậy thấp nhất ${Math.round(g.min * 100)}%): đối chiếu kỹ với ảnh gốc` });
    }
  }
  const imgs = new Map<number, ImageData>();
  const seen = new Set<number>();
  for (const k of sig.keyGaps) {
    if (seen.has(k.firstMeasure) || k.firstMeasure < 0) continue;
    const png = binaries[k.page];
    if (!png) continue;
    if (!imgs.has(k.page)) {
      const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      imgs.set(k.page, ctx.getImageData(0, 0, c.width, c.height));
    }
    const im = imgs.get(k.page)!;
    const x0 = Math.round(k.box.x * im.width);
    const x1 = Math.round((k.box.x + k.box.w) * im.width);
    const y0 = Math.round(k.box.y * im.height);
    const y1 = Math.round((k.box.y + k.box.h) * im.height);
    const lines = k.lines.map((y) => y * im.height);
    let n = 0;
    let dark = 0;
    for (let y = Math.max(0, y0); y < Math.min(im.height, y1); y++) {
      if (lines.some((l) => Math.abs(y - l) <= 2)) continue;
      for (let x = Math.max(0, x0); x < Math.min(im.width, x1); x++) {
        n++;
        if (im.data[(y * im.width + x) * 4]! < 128) dark++;
      }
    }
    if (n && dark / n > 0.02) {
      seen.add(k.firstMeasure);
      out.push({ measureIndex: k.firstMeasure, code: 'KEY_SUSPECT', message: 'Đầu dòng nhạc này có ký hiệu giữa khoá nhạc và số chỉ nhịp mà Audiveris không đọc được: nhiều khả năng sót hoá biểu (dấu thăng/giáng đầu khuông)' });
    }
  }
  return out;
}

// ------------------------------------------------------------------ Chuyển sang Edit

export interface ConvertProgress {
  phase: 'charge' | 'validate' | 'region' | 'done';
  done: number;
  total: number;
  text: string;
}

export interface ConvertResult {
  issues: RuleIssue[];
  fixed: number;
  regionsTried: number;
  regionsImproved: number;
}

/** Số ô nhịp/ hệ thống tối đa nhận dạng lại trong một lần chuyển (mỗi vùng mất ~15–40 giây) */
const MAX_REGIONS = 12;

export async function convertToEdit(
  score: ScoreDocument,
  exec: (cmd: import('@holy-melody/music-core').Command) => void,
  charge: () => Promise<{ credits: number; transaction_id: number | null; created_at: string }>,
  onProgress: (p: ConvertProgress) => void,
  isCancelled: () => boolean,
): Promise<ConvertResult> {
  const sheet = score.sheet;
  if (!sheet) throw new Error('Bản nhạc này không mở từ ảnh/PDF');
  const asset = getSheetAsset(score.id);

  // 1. trừ credit (máy chủ, idempotent theo file gốc)
  onProgress({ phase: 'charge', done: 0, total: 1, text: 'Xác nhận 10 credit với máy chủ…' });
  const conv = sheet.conversion ?? (await charge().then((c) => ({ at: c.created_at, credits: c.credits, transactionId: c.transaction_id ?? undefined })));

  // 2. Music Rule Validator + tự sửa an toàn
  onProgress({ phase: 'validate', done: 0, total: 1, text: 'Kiểm tra quy tắc âm nhạc…' });
  let issues = validateMusic(score);
  const safe = issues.filter((i) => i.autoFix && i.code !== 'UNDERFULL');
  if (safe.length) exec(autoFixIssues(safe));

  // 3. Region Re-recognition cho các ô có lỗi nặng (quy tắc âm nhạc + vùng khó phát hiện từ ảnh)
  issues = reviewIssues(score);
  const hard = [...difficulty(issues.filter((i) => !i.special))].filter(([, d]) => d >= 3).map(([mi]) => mi);
  const systems = new Map<number, number[]>();
  for (const mi of hard) {
    const g = sheet.measures.find((x) => x.measureIndex === mi);
    if (g) systems.set(g.system, [...(systems.get(g.system) ?? []), mi]);
  }
  let tried = 0;
  let improved = 0;
  const work = [...systems].slice(0, MAX_REGIONS);
  if (asset && tauriInvoke()) {
    for (const [sys, targets] of work) {
      if (isCancelled()) break;
      tried++;
      onProgress({ phase: 'region', done: tried - 1, total: work.length, text: `Nhận dạng lại dòng ${sys + 1} (ô ${targets.map((t) => score.measures[t]!.number).join(', ')})…` });
      if (await rerecognizeSystem(score, sys, targets, exec)) improved++;
    }
  }
  void issues;

  // 4. dựng khuông nhạc đầy đủ + đánh dấu các ô cần đối chiếu
  issues = reviewIssues(score);
  exec(enterEditMode(conv, issues));
  onProgress({ phase: 'done', done: work.length, total: work.length, text: 'Xong' });
  return { issues, fixed: safe.length, regionsTried: tried, regionsImproved: improved };
}

/**
 * Region Re-recognition: cắt riêng dòng nhạc `sys`, chạy lại Audiveris với từng cấu hình khác,
 * chỉ thay các ô `targets` và chỉ khi số lỗi quy tắc GIẢM. Trả về true nếu có cải thiện.
 */
export async function rerecognizeSystem(
  score: ScoreDocument, sys: number, targets: number[], exec: (cmd: import('@holy-melody/music-core').Command) => void,
): Promise<boolean> {
  const sheet = score.sheet;
  const asset = getSheetAsset(score.id);
  if (!sheet || !asset || !tauriInvoke()) return false;
  const sysGeoms = sheet.measures.filter((x) => x.system === sys).sort((a, b) => a.measureIndex - b.measureIndex);
  const box = regionOf(sysGeoms);
  if (!box) return false;
  const order = sysGeoms.map((g) => g.measureIndex);
  // nghi sót hoá biểu ở dòng này: nhận kết quả nếu lần nhận dạng vùng đọc được hoá biểu
  let keySuspect = !!sheet.signals?.some((x) => x.code === 'KEY_SUSPECT' && order.includes(x.measureIndex)) && !score.keyMap.some((k) => k.fifths !== 0);
  let improved = false;
  for (const cfg of REGION_CONFIGS) {
    try {
      const before = validateMusic(score, { measures: targets }).filter((i) => i.severity === 'error').length;
      if (before === 0 && !keySuspect) break;
      const png = await cropPng(asset, box, cfg);
      const src = importMusicXml(await runAudiveris(`region-${sys}-${cfg.id}.png`, png, { job: `r${sys}-${cfg.id}` }));
      const srcKey = src.keyMap.find((k) => k.fifths !== 0);
      if (keySuspect && srcKey) {
        exec(applyMissedKey(order[0]!, srcKey.fifths, srcKey.mode));
        keySuspect = false;
        improved = true;
      }
      // thử trên bản sao trước
      const trial: ScoreDocument = JSON.parse(JSON.stringify(score));
      const cmd = replaceMeasuresFrom(trial, src, order, targets, `audiveris-region:${cfg.id}`);
      if (!cmd) continue;
      cmd.apply(trial);
      const after = validateMusic(trial, { measures: targets }).filter((i) => i.severity === 'error').length;
      if (after < before) {
        exec(replaceMeasuresFrom(score, src, order, targets, `audiveris-region:${cfg.id}`)!);
        improved = true;
      }
    } catch {
      /* vùng này nhận dạng lại thất bại: giữ kết quả cũ */
    }
  }
  return improved;
}

/** Vùng ảnh gốc của một ô nhịp (có lề, gồm cả chiều cao dòng nhạc) */
export function measureBox(score: ScoreDocument, mi: number): SheetBox | null {
  const g = score.sheet?.measures.find((x) => x.measureIndex === mi);
  return g ? regionOf([g], 0.01) : null;
}
