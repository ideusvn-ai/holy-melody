/**
 * Xuất bản nhạc: trang in theo khổ giấy (A4/A5/Letter, dọc/ngang) → In / Lưu PDF (vector),
 * SVG, PNG; MXL; WAV (render SoundFont bằng engine Rust).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTimeline, exportMxl, type ScoreDocument } from '@holy-melody/music-core';
import { layoutScore, type ScoreLayout } from '@holy-melody/score-renderer';
import { ScoreSvgBody } from '../components/ScoreView';
import { saveBytes, tauriInvoke } from './fileio';

const MM = 96 / 25.4; // px mỗi mm ở 96 dpi

export function pageSizeMm(score: ScoreDocument): { w: number; h: number } {
  const L = score.layout;
  const base = L.pageSize === 'A5' ? [148, 210] : L.pageSize === 'Letter' ? [215.9, 279.4] : L.pageSize === 'Custom' ? [L.pageWidthMm, L.pageHeightMm] : [210, 297];
  const [w, h] = L.orientation === 'landscape' ? [base[1]!, base[0]!] : [base[0]!, base[1]!];
  return { w, h };
}

export interface Page {
  y0: number;
  height: number;
}

/** Chia các hệ thống khuông vào từng trang; không cắt ngang một hệ thống; tôn trọng ngắt trang thủ công */
export function paginate(score: ScoreDocument, layout: ScoreLayout, pageHeightPx: number): Page[] {
  const top = score.layout.marginsMm.top * MM;
  const bottom = score.layout.marginsMm.bottom * MM + 24; // chừa số trang
  const usable = pageHeightPx - top - bottom;
  const pages: Page[] = [{ y0: 0, height: pageHeightPx }];
  let pageStart = 0; // y (trong layout) của đầu trang hiện tại
  layout.systems.forEach((sys, i) => {
    const sysTop = sys.y - layout.sp * 5; // gồm ký hiệu hợp âm/láy phía trên
    const next = layout.systems[i + 1];
    const sysBottom = next ? next.y - layout.sp * 5 : layout.height;
    const forced = i > 0 && score.measures[sys.measures[0]!.index]?.pageBreak;
    const firstOnPage = i === 0 || sysTop - pageStart <= top + 1;
    if (!firstOnPage && (forced || sysBottom - pageStart > top + usable)) {
      pageStart = sysTop - top;
      pages.push({ y0: pageStart, height: pageHeightPx });
    }
  });
  return pages;
}

function svgDoc(inner: string, w: number, h: number, viewBox: string, pageNo?: { n: number; total: number; show: boolean }) {
  const num = pageNo && pageNo.show && pageNo.total > 1
    ? `<text x="${w / 2}" y="${h - 18}" font-size="11" text-anchor="middle" fill="#555" font-family="Georgia, serif">${pageNo.n}</text>`
    : '';
  const [vx, vy, vw, vh] = viewBox.split(' ').map(Number);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="color:#1d1c1a;background:#fff">`
    + `<rect width="${w}" height="${h}" fill="#fff"/>`
    + `<svg x="0" y="0" width="${w}" height="${h}" viewBox="${vx} ${vy} ${vw} ${vh}" overflow="hidden">${inner}</svg>`
    + num + '</svg>';
}

function bodyMarkup(score: ScoreDocument, layout: ScoreLayout): string {
  return renderToStaticMarkup(<ScoreSvgBody layout={layout} score={score} />)
    // nền chọn ô nhịp không cần khi in
    .replace(/<rect class="hm-measure-bg[^"]*"[^>]*\/>/g, '');
}

/** Các trang SVG theo khổ giấy của bản nhạc */
export function renderPages(score: ScoreDocument): { svgs: string[]; widthPx: number; heightPx: number; mm: { w: number; h: number } } {
  const mm = pageSizeMm(score);
  const widthPx = Math.round(mm.w * MM);
  const heightPx = Math.round(mm.h * MM);
  const layout = layoutScore(score, { width: widthPx, sp: Math.max(5, score.layout.staffSpaceMm * MM) });
  const inner = bodyMarkup(score, layout);
  const pages = paginate(score, layout, heightPx);
  const svgs = pages.map((p, i) => svgDoc(inner, widthPx, heightPx, `0 ${p.y0} ${widthPx} ${heightPx}`, { n: i + 1, total: pages.length, show: score.layout.showPageNumbers }));
  return { svgs, widthPx, heightPx, mm };
}

/** In / Lưu PDF: hộp thoại in của hệ điều hành (chọn "Lưu thành PDF" / "Microsoft Print to PDF") */
export async function printScore(score: ScoreDocument): Promise<void> {
  const { svgs, mm } = renderPages(score);
  document.getElementById('hm-print')?.remove();
  document.getElementById('hm-print-style')?.remove();
  const style = document.createElement('style');
  style.id = 'hm-print-style';
  style.textContent = `
    @page { size: ${mm.w}mm ${mm.h}mm; margin: 0; }
    @media screen { #hm-print { display: none; } }
    @media print {
      html, body { background: #fff !important; height: auto !important; }
      #root { display: none !important; }
      #hm-print { display: block; }
      #hm-print .hm-page { width: ${mm.w}mm; height: ${mm.h}mm; page-break-after: always; break-after: page; overflow: hidden; }
      #hm-print .hm-page:last-child { page-break-after: auto; break-after: auto; }
      #hm-print svg { width: 100%; height: 100%; display: block; }
    }`;
  const host = document.createElement('div');
  host.id = 'hm-print';
  host.innerHTML = svgs.map((s) => `<div class="hm-page">${s}</div>`).join('');
  document.head.appendChild(style);
  document.body.appendChild(host);
  const cleanup = () => {
    host.remove();
    style.remove();
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  const invoke = tauriInvoke();
  try {
    if (invoke) await invoke('print_page');
    else window.print();
  } finally {
    // một số WebView không phát afterprint
    setTimeout(cleanup, 60_000);
  }
}

export async function exportSvgFile(score: ScoreDocument, page = 0) {
  const { svgs } = renderPages(score);
  const name = (score.meta.title || 'score').replace(/[\\/:*?"<>|]+/g, '_');
  const all = svgs.length === 1 ? [svgs[0]!] : svgs;
  if (page >= 0 && svgs.length > 1) {
    return saveBytes(`${name}-trang-${page + 1}.svg`, new TextEncoder().encode(svgs[page]!), 'image/svg+xml', [{ name: 'SVG', extensions: ['svg'] }]);
  }
  return saveBytes(`${name}.svg`, new TextEncoder().encode(all[0]!), 'image/svg+xml', [{ name: 'SVG', extensions: ['svg'] }]);
}

/** PNG 300 dpi của một trang */
export async function exportPngFile(score: ScoreDocument, page = 0, dpi = 300) {
  const { svgs, widthPx, heightPx } = renderPages(score);
  const scale = dpi / 96;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgs[page] ?? svgs[0]!], { type: 'image/svg+xml' }));
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('Không dựng được ảnh PNG'));
    img.src = url;
  });
  const c = document.createElement('canvas');
  c.width = Math.round(widthPx * scale);
  c.height = Math.round(heightPx * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Không tạo được PNG'))), 'image/png'));
  const name = (score.meta.title || 'score').replace(/[\\/:*?"<>|]+/g, '_');
  return saveBytes(`${name}${svgs.length > 1 ? `-trang-${page + 1}` : ''}.png`, new Uint8Array(await blob.arrayBuffer()), 'image/png', [{ name: 'PNG', extensions: ['png'] }]);
}

export async function exportMxlFile(score: ScoreDocument) {
  const name = (score.meta.title || 'score').replace(/[\\/:*?"<>|]+/g, '_');
  return saveBytes(`${name}.mxl`, await exportMxl(score), 'application/vnd.recordare.musicxml', [{ name: 'MusicXML nén', extensions: ['mxl'] }]);
}

/** Xuất WAV bằng engine SoundFont (chỉ có trong app desktop) */
export async function exportWavFile(score: ScoreDocument, mixer: { partId: string; volume: number; pan: number; mute: boolean }[]): Promise<string | undefined> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('Xuất WAV cần chạy trong ứng dụng desktop (engine SoundFont).');
  if ((await invoke('playback_engine_available')) !== true) throw new Error('Engine SoundFont chưa sẵn sàng nên chưa xuất WAV được.');
  const name = (score.meta.title || 'score').replace(/[\\/:*?"<>|]+/g, '_');
  const path = (await invoke('plugin:dialog|save', { options: { defaultPath: `${name}.wav`, filters: [{ name: 'WAV', extensions: ['wav'] }] } })) as string | null;
  if (!path) return undefined;
  const tl = buildTimeline(score);
  const chan = new Map(tl.parts.map((p) => [p.partId, p.channel]));
  await invoke('export_wav', {
    path,
    args: {
      ticksPerQuarter: tl.ticksPerQuarter, totalTicks: tl.totalTicks, tempo: tl.tempo, beats: [],
      notes: tl.notes.map((n) => ({ tick: n.tick, durationTicks: n.durationTicks, channel: n.channel, program: n.program, pitch: n.pitch, velocity: n.velocity })),
    },
    mixer: mixer.filter((m) => chan.has(m.partId)).map((m) => ({ channel: chan.get(m.partId)!, volume: m.volume, pan: m.pan, mute: m.mute })),
  });
  return path;
}
