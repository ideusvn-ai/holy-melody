/**
 * Bản nhạc mở từ ảnh/PDF.
 *  - Player: hiển thị TRANG GỐC (PDF vẽ dạng vector bằng pdf.js theo mức zoom; ảnh hiển thị trực tiếp) và một
 *    lớp phủ lấy từ MusicXML của Audiveris để phát MIDI + tô sáng. Chưa dựng khuông nhạc.
 *  - "Chuyển sang Edit" (50 credit, admin miễn phí, một lần cho mỗi file gốc): Validator → nhận dạng lại các vùng lỗi → dựng khuông
 *    nhạc đầy đủ → người dùng đối chiếu từng ô với ảnh gốc, kết quả + tọa độ lưu vĩnh viễn trong dự án.
 */
import {
  applyMissedKey, autoFixIssues, distributeLyrics, lyricTargetsIn, concatScores, exportMusicXml, keyAt, replaceRecognition, sliceScore, timeSigAt, estimateInterline, fastOmrScale, createScore, hasExplicitTime, newId, difficulty, enterEditMode, extractOmrGeometry, extractOmrSignals, reviewIssues, type OmrSignal, type SheetMeasureGeom, extractSheetGeometry, readZip, importMusicXml, markAllUnverified, readMxl,
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

/** Ghi file tạm cho Audiveris (dữ liệu nhị phân thô, không qua mảng JSON) */
export async function writeOmrInput(name: string, bytes: Uint8Array): Promise<string> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('Nhận dạng ảnh/PDF cần chạy trong ứng dụng desktop.');
  const path = (await invoke('omr_temp_input', { name })) as string;
  // cầu nối IPC của Tauri nhận thẳng Uint8Array làm thân yêu cầu (không chuyển thành mảng JSON)
  const raw = (globalThis as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: Uint8Array, opts: { headers: Record<string, string> }) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
  await raw('write_file_raw', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
  return path;
}

export interface OmrPageResult {
  xml: string;
  /** XML từng trang trong dự án .omr, theo số trang (bắt đầu từ 1) */
  sheets: Map<number, string>;
  binaries: Map<number, Uint8Array>;
}

/** Như runAudiveris, kèm XML từng trang trong dự án .omr (tọa độ pixel chính xác) */
export async function runAudiverisFull(
  name: string, bytes: Uint8Array | null,
  opts: { job?: string; options?: string[]; onProgress?: (stage: number, line: string) => void; inputPath?: string; sheets?: string } = {},
): Promise<OmrPageResult> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('Nhận dạng ảnh/PDF cần chạy trong ứng dụng desktop.');
  let unlisten: (() => void) | undefined;
  try {
    if (opts.onProgress) {
      const { listen } = (await import('@tauri-apps/api/event')) as unknown as { listen: Listen };
      unlisten = await listen('omr://progress', (e) => opts.onProgress!(e.payload.stage, e.payload.line));
    }
    const path = opts.inputPath ?? (await writeOmrInput(name, bytes!));
    const out = (await invoke('omr_run', { input: path, options: opts.options ?? null, job: opts.job ?? null, sheets: opts.sheets ?? null })) as { mxlPath: string; omrPath?: string | null };
    const mxl = new Uint8Array((await invoke('read_file', { path: out.mxlPath })) as ArrayBuffer);
    const xml = await readMxl(mxl);
    const sheets = new Map<number, string>();
    const binaries = new Map<number, Uint8Array>();
    if (out.omrPath) {
      try {
        const files = await readZip(new Uint8Array((await invoke('read_file', { path: out.omrPath })) as ArrayBuffer));
        const dec = new TextDecoder();
        for (const [n, data] of files) {
          const m = /^sheet#(\d+)\/sheet#\d+\.xml$/.exec(n);
          if (!m) continue;
          sheets.set(Number(m[1]), dec.decode(data));
          const bin = files.get(n.replace(/[^/]+$/, 'BINARY.png'));
          if (bin) binaries.set(Number(m[1]), bin);
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

/** Audiveris luôn gán mặc định "Voice Oohs" (âm sắc phồng dần → nghe lúc to lúc nhỏ): đổi sang organ, âm lượng đều */
export function fixOmrInstruments(score: ScoreDocument): void {
  for (const p of score.parts) {
    if (p.instrument.program === 53 || /voice oohs/i.test(p.instrument.name)) {
      p.instrument.program = 19;
      p.instrument.name = 'Organ nhà thờ';
    }
  }
}

export interface OpenSheetHandlers {
  /** Gọi NGAY khi đọc xong file: bản gốc hiển thị được, nhận dạng chạy nền */
  onPlaceholder(score: ScoreDocument): void;
  /** Kết quả mới (theo từng trang hoặc cuối cùng) */
  onUpdate(score: ScoreDocument): void;
  onProgress?(stage: number, line: string): void;
}

const CACHE_VERSION = 3;

/** Ghép kết quả các trang thành bản nhạc + tọa độ lớp phủ (null nếu không có nốt hoặc không ghép được) */
export function buildSheetScore(
  xmls: (string | null)[], sheetXmls: string[], base: { id: string; title: string; sheet: Omit<SheetSource, 'measures' | 'reviews' | 'mode'> & Partial<SheetSource> },
): ScoreDocument | null {
  const parts = xmls.map((x) => (x ? importMusicXml(x) : null));
  const present = parts.map((p, i) => ({ p, i })).filter((x) => x.p && x.p.measures.length);
  if (!present.length) return null;
  const merged = present.length === 1 ? present[0]!.p! : concatScores(present.map((x) => x.p!), present.map((x) => hasExplicitTime(xmls[x.i]!)));
  if (!merged) return null;
  const geom = sheetXmls.some(Boolean) ? extractOmrGeometry(sheetXmls) : null;
  const measures = geom && geom.length === merged.measures.length ? geom
    : xmls.length === 1 && xmls[0] ? (extractSheetGeometry(xmls[0])?.measures ?? []) : [];
  merged.id = base.id;
  if (!merged.meta.title || merged.meta.title === 'Untitled') merged.meta.title = base.title;
  fixOmrInstruments(merged);
  markAllUnverified(merged);
  merged.sheet = { mode: 'overlay', reviews: {}, ...base.sheet, measures };
  return merged;
}

/** Một trang đã chuẩn bị cho Audiveris (chế độ nhanh: thu nhỏ về interline ~15 px) */
interface PreparedPage { name: string; bytes: Uint8Array; scale: number; interline: number | null }

/** Ảnh xám (kênh đỏ) từ canvas để đo interline; lấy mẫu thu nhỏ nếu ảnh quá lớn */
function grayOf(c: HTMLCanvasElement): { gray: Uint8ClampedArray; w: number; h: number; stride: number } {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { gray: d.data, w: c.width, h: c.height, stride: 4 };
}

async function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('Không tạo được ảnh trang'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Chuẩn bị trang `k` cho chế độ nhanh: PDF vẽ ở 300 dpi; đo interline; thu nhỏ nếu dòng kẻ thưa */
async function preparePage(asset: SheetAsset, k: number, fileName: string): Promise<PreparedPage> {
  let src: HTMLCanvasElement;
  if (asset.kind === 'pdf') {
    const doc = await pdfOf(asset);
    const page = await doc.getPage(k + 1);
    src = await pageRaster(asset, k, page.getViewport({ scale: 300 / 72 }).width);
  } else {
    src = await pageRaster(asset, 0, (await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }))).width);
  }
  const g = grayOf(src);
  const interline = estimateInterline(g.gray, g.w, g.h, g.stride);
  const scale = fastOmrScale(interline);
  const base = fileName.replace(/\.[^.]+$/, '');
  if (scale >= 0.98) {
    // giữ nguyên ảnh gốc (không mã hoá lại) khi không cần thu nhỏ
    if (asset.kind === 'image') return { name: fileName, bytes: asset.bytes, scale: 1, interline };
    return { name: `${base}-p${k + 1}.png`, bytes: await canvasToPng(src), scale: 1, interline };
  }
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return { name: `${base}-p${k + 1}-fast.png`, bytes: await canvasToPng(c), scale, interline };
}

/**
 * Mở ảnh/PDF cho PLAYER — nhanh nhất có thể, chỉ cần lớp nốt để phát:
 *  1. hiện bản gốc ngay (không chờ nhận dạng);
 *  2. đã từng mở file này → lấy kết quả đã lưu (theo SHA-256), không chạy lại Audiveris;
 *  3. mỗi trang được thu nhỏ về khoảng cách dòng kẻ ~15 px (đo thực tế: nhanh hơn 20–35%, không sót nốt)
 *     và nhận dạng riêng → trang 1 xong là phát được; máy ≥ 8 nhân chạy song song;
 *  4. nhận dạng KỸ (độ phân giải gốc, có lời ca) + AI chỉ chạy khi "Chuyển sang Editor".
 */
export async function openSheet(file: File, h: OpenSheetHandlers): Promise<ScoreDocument> {
  const invoke = tauriInvoke();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind: 'image' | 'pdf' = /\.pdf$/i.test(file.name) ? 'pdf' : 'image';
  const asset: SheetAsset = { kind, bytes, mime: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/png') };
  const title = file.name.replace(/\.[^.]+$/, '');
  const [hash, pages] = await Promise.all([sha256Hex(bytes), pageSizes(asset, file.name)]);

  // ---- 2. kết quả đã lưu
  if (invoke) {
    const cached = (await invoke('omr_cache_get', { hash }).catch(() => null)) as string | null;
    if (cached) {
      try {
        const c = JSON.parse(cached) as { v: number; score: ScoreDocument };
        if (c.v === CACHE_VERSION && c.score.sheet) {
          c.score.id = newId('sc');
          c.score.sheet = { ...c.score.sheet, fileName: file.name, pages };
          setSheetAsset(c.score.id, asset);
          h.onPlaceholder(c.score);
          return c.score;
        }
      } catch {
        /* bộ đệm hỏng: nhận dạng lại */
      }
    }
  }

  // ---- 1. bản gốc hiện ngay
  const placeholder = createScore({ title, measures: 1, parts: [{ name: 'Đang nhận dạng…' }] });
  const total = pages.length;
  placeholder.sheet = { kind, fileName: file.name, hash, pages, measures: [], mode: 'overlay', reviews: {}, pending: { done: 0, total }, omrMode: 'fast' };
  setSheetAsset(placeholder.id, asset);
  h.onPlaceholder(placeholder);
  const sheetBase = { kind, fileName: file.name, hash, pages, omrMode: 'fast' as const };
  const build = (xs: (string | null)[], sx: string[], done: number, final: boolean) =>
    buildSheetScore(xs, sx, { id: placeholder.id, title, sheet: { ...sheetBase, pending: final ? undefined : { done, total } } });

  // ---- 3. từng trang: chuẩn bị (thu nhỏ) → Audiveris
  const xmls: (string | null)[] = new Array(total).fill(null);
  const sheetXmls: string[] = new Array(total).fill('');
  const binaries: (Uint8Array | undefined)[] = new Array(total).fill(undefined);
  const settled: boolean[] = new Array(total).fill(false);
  let finished = 0;
  let shown = 0;
  let lastError = '';
  const cores = navigator.hardwareConcurrency || 4;
  const workers = Math.max(1, Math.min(total, 4, Math.floor(cores / 4)));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < total) {
      const k = next++;
      try {
        const pg = await preparePage(asset, k, file.name);
        const r = await runAudiverisFull(pg.name, pg.bytes, { job: `p${k + 1}`, onProgress: k === 0 ? h.onProgress : undefined });
        xmls[k] = r.xml;
        sheetXmls[k] = r.sheets.get(1) ?? r.sheets.values().next().value ?? '';
        binaries[k] = r.binaries.get(1) ?? r.binaries.values().next().value;
      } catch (e) {
        lastError = String((e as Error).message ?? e); // trang không có nhạc (bìa, lời): bỏ qua
      }
      settled[k] = true;
      finished++;
      if (finished === total) continue;
      let prefix = 0;
      while (prefix < total && settled[prefix]) prefix++;
      if (prefix > shown) {
        const part = build(xmls.slice(0, prefix), sheetXmls.slice(0, prefix), finished, false);
        if (part) {
          shown = prefix;
          h.onUpdate(part);
          continue;
        }
      }
      if (!shown) h.onUpdate({ ...placeholder, sheet: { ...placeholder.sheet!, pending: { done: finished, total } } });
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));

  let result = build(xmls, sheetXmls, finished, true);
  if (!result && total > 1 && xmls.some(Boolean)) {
    // các trang không ghép được (số bè khác nhau…) → nhận dạng cả file một lần
    const r = await runAudiverisFull(file.name, bytes, { job: 'all', onProgress: h.onProgress });
    const all = [...r.sheets.keys()].sort((a, b) => a - b);
    result = build([r.xml], all.length ? all.map((k) => r.sheets.get(k)!) : [''], 1, true);
    all.forEach((k, i) => (binaries[i] = r.binaries.get(k)));
    if (result) sheetXmls.splice(0, sheetXmls.length, ...all.map((k) => r.sheets.get(k)!));
  }
  if (!result) {
    const fail = { ...placeholder, sheet: { ...placeholder.sheet!, pending: { done: total, total, error: lastError || 'Không nhận dạng được bản nhạc trong file này' } } };
    h.onUpdate(fail);
    throw new Error(fail.sheet.pending.error);
  }
  if (result.sheet!.measures.length && sheetXmls.some(Boolean)) {
    result.sheet!.signals = await detectHardRegions(sheetXmls, binaries, result.sheet!.measures).catch(() => []);
  }
  h.onUpdate(result);
  if (invoke) void invoke('omr_cache_put', { hash, json: JSON.stringify({ v: CACHE_VERSION, score: result }) }).catch(() => undefined);
  return result;
}

async function pageSizes(asset: SheetAsset, fileName: string): Promise<SheetSource['pages']> {
  const pages: SheetSource['pages'] = [];
  if (asset.kind === 'pdf') {
    const doc = await pdfOf(asset);
    for (let i = 0; i < doc.numPages; i++) {
      const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      pages.push({ file: 'source.pdf', width: vp.width, height: vp.height });
    }
  } else {
    const img = await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime })).catch(() => null);
    pages.push({ file: `source.${fileName.split('.').pop()?.toLowerCase() ?? 'png'}`, width: img?.width ?? 0, height: img?.height ?? 0 });
  }
  return pages;
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
  phase: 'charge' | 'full' | 'validate' | 'region' | 'ai' | 'done';
  done: number;
  total: number;
  text: string;
}

export interface ConvertResult {
  issues: RuleIssue[];
  fixed: number;
  regionsTried: number;
  regionsImproved: number;
  aiTried: number;
  aiImproved: number;
  /** số dòng AI đọc được lời ca */
  aiLyrics: number;
  /** số ô AI đọc khác Audiveris (đưa vào bảng Đối chiếu) */
  aiDiffs: number;
  /** Lý do bỏ qua AI (chưa cấu hình, hết lượt…) */
  aiNote: string;
}

/** Số dòng nhạc tối đa nhận dạng lại bằng Audiveris trong một lần chuyển (mỗi vùng ~8–20 giây) */
const MAX_REGIONS = 12;
/** Số yêu cầu AI chạy song song */
const AI_CONCURRENCY = 4;

/** Gọi AI đọc lại một dòng nhạc (máy chủ, OpenAI). mode 'review' = rà soát toàn dòng. */
export type AiRegionCall = (req: { image_png_base64: string; musicxml: string; measures: number[]; context: Record<string, unknown>; mode?: 'region' | 'review' }) => Promise<{ musicxml: string; model: string } | null>;
/** Gọi AI đọc lời ca (tiếng Việt) của một dòng nhạc: các lời, mỗi lời là danh sách âm tiết */
export type AiLyricsCall = (req: { image_png_base64: string; notes: number }) => Promise<{ verses: string[][]; model: string } | null>;

/** Chuỗi đặc trưng nốt của một ô (để so AI với Audiveris) */
function measurePrint(score: ScoreDocument, mi: number): string {
  const m = score.measures[mi];
  if (!m) return '';
  return score.parts.map((p) => (p.content[m.id] ?? []).map((v) => v.events.map((e) =>
    e.kind === 'chord' ? `${e.notes.map((n) => `${n.pitch.step}${n.pitch.alter}${n.pitch.octave}`).sort().join('+')}/${e.duration.type}${e.duration.dots}` : `r/${e.kind === 'rest' ? e.duration.type : ''}`,
  ).join(' ')).join('|')).join('||');
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>, stop: () => boolean): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      await fn(items[i]!, i);
    }
  }));
}

/**
 * "Chuyển sang Editor":
 *  1. trừ credit (máy chủ, một lần cho mỗi file gốc; admin miễn phí);
 *  2. trang nào chưa nhận dạng được (hoặc không có AI) → nhận dạng kỹ ở độ phân giải gốc, OCR tiếng Việt;
 *  3. Music Rule Validator + tự sửa lỗi an toàn;
 *  4. AI (OpenAI) chạy song song theo từng dòng nhạc: đọc LỜI CA tiếng Việt + RÀ SOÁT toàn dòng so với ảnh gốc.
 *     Nốt: chỉ nhận khi số lỗi quy tắc GIẢM; ô AI đọc khác nhưng không chứng minh được ai đúng → đưa vào "Đối chiếu".
 *     Không có AI → nhận dạng lại theo vùng bằng Audiveris với cấu hình khác;
 *  5. dựng khuông nhạc + danh sách ô cần đối chiếu.
 */
export async function convertToEdit(
  score: ScoreDocument,
  exec: (cmd: import('@holy-melody/music-core').Command) => void,
  charge: () => Promise<{ credits: number; transaction_id: number | null; created_at: string }>,
  onProgress: (p: ConvertProgress) => void,
  isCancelled: () => boolean,
  ai?: { region: AiRegionCall; lyrics?: AiLyricsCall; enabled: boolean },
): Promise<ConvertResult> {
  const sheet = score.sheet;
  if (!sheet) throw new Error('Bản nhạc này không mở từ ảnh/PDF');
  const asset = getSheetAsset(score.id);
  const useAi = !!ai?.enabled;

  // 1. trừ credit
  onProgress({ phase: 'charge', done: 0, total: 1, text: 'Xác nhận credit với máy chủ…' });
  const conv: NonNullable<SheetSource['conversion']> = sheet.conversion ?? (await charge().then((c) => ({ at: c.created_at, credits: c.credits, transactionId: c.transaction_id ?? undefined })));

  // 2. phần còn thiếu: trang chưa nhận dạng được (Player) → nhận dạng kỹ; không có AI → chạy kỹ cả bài để có lời ca (OCR tiếng Việt)
  const recognizedPages = new Set(sheet.measures.map((g) => g.page));
  const missingPages = sheet.pages.map((_, i) => i).filter((i) => !recognizedPages.has(i));
  const needFull = sheet.omrMode !== 'full' && (missingPages.length > 0 || !useAi || !sheet.measures.length);
  if (needFull && asset && tauriInvoke() && !isCancelled()) {
    onProgress({ phase: 'full', done: 0, total: 1, text: missingPages.length && sheet.measures.length
      ? `Nhận dạng tiếp ${missingPages.length} trang còn thiếu ở độ phân giải gốc…` : 'Nhận dạng kỹ ở độ phân giải gốc (đọc lời ca tiếng Việt)…' });
    try {
      const r = await runAudiverisFull(sheet.fileName, asset.bytes, { job: 'full', options: [VIE_OCR] });
      const keys = [...r.sheets.keys()].sort((a, b) => a - b);
      const sx = keys.map((k) => r.sheets.get(k)!);
      const full = buildSheetScore([r.xml], sx.length ? sx : [''], { id: score.id, title: score.meta.title, sheet: { kind: sheet.kind, fileName: sheet.fileName, hash: sheet.hash, pages: sheet.pages, omrMode: 'full' } });
      if (full && full.measures.length >= score.measures.length) {
        if (full.sheet!.measures.length) full.sheet!.signals = await detectHardRegions(sx, keys.map((k) => r.binaries.get(k)), full.sheet!.measures).catch(() => []);
        exec(replaceRecognition(full));
      }
    } catch {
      /* nhận dạng kỹ thất bại: dùng tiếp kết quả nhanh */
    }
  }

  // 3. Music Rule Validator + tự sửa an toàn
  onProgress({ phase: 'validate', done: 0, total: 1, text: 'Kiểm tra quy tắc âm nhạc…' });
  let issues = validateMusic(score);
  const safe = issues.filter((i) => i.autoFix && i.code !== 'UNDERFULL');
  if (safe.length) exec(autoFixIssues(safe));

  const sh = () => score.sheet!;
  const systemsAll = [...new Set(sh().measures.map((g) => g.system))].sort((a, b) => a - b);
  issues = reviewIssues(score);
  const hard = [...difficulty(issues.filter((i) => !i.special))].filter(([, d]) => d >= 3).map(([mi]) => mi);
  const hardBySystem = new Map<number, number[]>();
  for (const mi of hard) {
    const g = sh().measures.find((x) => x.measureIndex === mi);
    if (g) hardBySystem.set(g.system, [...(hardBySystem.get(g.system) ?? []), mi]);
  }

  // 4a. AI theo từng dòng: lời ca + rà soát
  let aiTried = 0;
  let aiImproved = 0;
  let aiLyrics = 0;
  let aiNote = '';
  const diffs: OmrSignal[] = [];
  let aiDead = false;
  const lyricPart = score.parts.find((p) => Object.values(p.content).some((vs) => vs.some((v) => v.events.some((e) => e.kind === 'chord' && e.lyrics.length)))) ?? score.parts[0];
  const lyricResults = new Map<number, string[][]>();
  if (useAi && ai && asset && !isCancelled()) {
    let done = 0;
    onProgress({ phase: 'ai', done: 0, total: systemsAll.length, text: `AI đọc lời ca và rà soát ${systemsAll.length} dòng nhạc…` });
    await pool(systemsAll, AI_CONCURRENCY, async (sys) => {
      if (aiDead) return;
      const geoms = sh().measures.filter((x) => x.system === sys).sort((a, b) => a.measureIndex - b.measureIndex);
      const box = regionOf(geoms);
      if (!box) return;
      const order = geoms.map((g) => g.measureIndex);
      const png = await cropPng(asset, box, REGION_CONFIGS[0]!);
      const b64 = toBase64(png);
      const fail = (e: Error) => {
        const m = String(e.message ?? e);
        aiNote = m;
        if (/AI_UNAVAILABLE|AI_QUOTA|chưa cấu hình|hết .* lượt|INSUFFICIENT|401|402/i.test(m)) aiDead = true;
        return null;
      };
      const ts = timeSigAt(score, order[0]!);
      const [lyr, rev] = await Promise.all([
        ai.lyrics && lyricPart
          ? ai.lyrics({ image_png_base64: b64, notes: lyricTargetsIn(score, lyricPart.id, order).length }).catch(fail)
          : Promise.resolve(null),
        ai.region({
          image_png_base64: b64, mode: 'review', measures: (hardBySystem.get(sys) ?? []).map((t) => order.indexOf(t) + 1),
          musicxml: exportMusicXml(sliceScore(score, order)),
          context: { key: keyAt(score, order[0]!), time: `${ts.beats}/${ts.beatType}`, parts: score.parts.map((p) => p.name) },
        }).catch(fail),
      ]);
      aiTried++;
      if (lyr?.verses.length) lyricResults.set(sys, lyr.verses);
      if (rev) {
        try {
          const src = importMusicXml(rev.musicxml);
          if (src.measures.length === order.length) {
            const trial: ScoreDocument = JSON.parse(JSON.stringify(score));
            const cmd = replaceMeasuresFrom(trial, src, order, order, `ai:${rev.model}`);
            if (cmd) {
              cmd.apply(trial);
              const accept: number[] = [];
              for (const mi of order) {
                if (measurePrint(trial, mi) === measurePrint(score, mi)) continue;
                const before = validateMusic(score, { measures: [mi] }).filter((i) => i.severity === 'error').length;
                const after = validateMusic(trial, { measures: [mi] }).filter((i) => i.severity === 'error').length;
                if (after < before) accept.push(mi);
                else if (after === before) {
                  diffs.push({ measureIndex: mi, code: 'AI_DIFF', message: `AI rà soát đọc ô ${score.measures[mi]!.number} khác kết quả nhận dạng — hãy so với ảnh gốc` });
                }
              }
              if (accept.length) {
                const c2 = replaceMeasuresFrom(score, src, order, accept, `ai:${rev.model}`);
                if (c2) {
                  exec(c2);
                  aiImproved += accept.length;
                }
              }
            }
          }
        } catch {
          /* AI trả MusicXML không dùng được: giữ kết quả cũ */
        }
      }
      onProgress({ phase: 'ai', done: ++done, total: systemsAll.length, text: `AI đã rà soát ${done}/${systemsAll.length} dòng…` });
    }, isCancelled);
    // lời ca: phân bổ theo từng dòng, theo thứ tự (mỗi dòng bắt đầu từ nốt đầu tiên của dòng)
    if (lyricPart && lyricResults.size) {
      for (const sys of systemsAll) {
        const verses = lyricResults.get(sys);
        if (!verses) continue;
        const order = sh().measures.filter((x) => x.system === sys).map((g) => g.measureIndex).sort((a, b) => a - b);
        if (!lyricTargetsIn(score, lyricPart.id, order).length) continue;
        verses.forEach((syl, v) => {
          try {
            // chỉ trong dòng này: lời của dòng khác (kể cả lời Audiveris đọc được) giữ nguyên
            exec(distributeLyrics({ partId: lyricPart.id, verse: v + 1, text: syl.join(' '), measures: order }));
          } catch {
            /* bỏ qua lời không gán được */
          }
        });
        aiLyrics++;
      }
    }
  }

  // 4b. Không có AI (hoặc AI lỗi): nhận dạng lại theo vùng bằng Audiveris với cấu hình khác
  let tried = 0;
  let improved = 0;
  const work = [...hardBySystem].filter(([, t]) => validateMusic(score, { measures: t }).some((i) => i.severity === 'error')).slice(0, MAX_REGIONS);
  if ((!useAi || aiDead) && asset && tauriInvoke()) {
    for (const [sys, targets] of work) {
      if (isCancelled()) break;
      tried++;
      onProgress({ phase: 'region', done: tried - 1, total: work.length, text: `Nhận dạng lại dòng ${sys + 1} (ô ${targets.map((t) => score.measures[t]!.number).join(', ')})…` });
      if (await rerecognizeSystem(score, sys, targets, exec)) improved++;
    }
  }

  // 5. dựng khuông nhạc đầy đủ + đánh dấu các ô cần đối chiếu (gồm ô AI đọc khác)
  if (diffs.length) {
    const signals = [...(score.sheet!.signals ?? []).filter((x) => x.code !== 'AI_DIFF'), ...diffs];
    exec({ label: 'Ghi các ô AI đọc khác', scope: () => ({ kind: 'all' }), apply: (s) => { if (s.sheet) s.sheet.signals = signals; } });
  }
  issues = reviewIssues(score);
  exec(enterEditMode(conv, issues));
  onProgress({ phase: 'done', done: 1, total: 1, text: 'Xong' });
  return { issues, fixed: safe.length, regionsTried: tried, regionsImproved: improved, aiTried, aiImproved, aiLyrics, aiDiffs: diffs.length, aiNote };
}

/** Audiveris: OCR lời ca bằng tiếng Việt + tiếng Anh (dữ liệu Tesseract đóng gói kèm) */
const VIE_OCR = 'const:org.audiveris.omr.text.Language.defaultSpecification=vie+eng';

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

function toBase64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}
