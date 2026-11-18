/**
 * Player cho bản nhạc mở từ ảnh/PDF: hiển thị trang gốc (PDF vẽ vector theo zoom) và lớp phủ nhận dạng
 * trong suốt để phát MIDI. Khi phát, CHỈ các đầu nốt đang vang sáng lên (tọa độ đầu nốt từ Audiveris).
 * Bấm vào ô nhịp để phát từ đó. Nhận dạng chạy nền: kết quả về dần theo trang.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cursorX, HighlightIndex, measureAtTick, measureTicks, type SheetSource } from '@holy-melody/music-core';
import { useActiveProject, useStore } from '../state/store';
import { markSelectionPlayed, playbackPosition, usePlayback } from '../state/playback';
import { OMR_STEPS, useOmrProgress } from '../state/omrProgress';
import { getSheetAsset, imageUrl, renderPdfPage, type SheetAsset } from '../lib/sheet';
import { ConvertDialog } from './ConvertDialog';
import { CountIn } from './CountIn';

export function SheetView() {
  const project = useActiveProject();
  const zoom = useStore((s) => s.layout.zoom);
  const tl = useStore((s) => s.timeline);
  const [showBoxes, setShowBoxes] = useState(false);
  const [convert, setConvert] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(900);
  const layers = useRef(new Map<number, SVGGElement>());
  const cursors = useRef(new Map<number, SVGLineElement>());
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const sheet = project?.score.sheet;
  const stage = useOmrProgress((s) => (project ? s.stage[project.score.id] ?? 0 : 0));

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - 48));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const asset = project ? getSheetAsset(project.score.id) : undefined;
  const byMeasure = useMemo(() => new Map((sheet?.measures ?? []).map((g) => [g.measureIndex, g])), [sheet]);
  const hi = useMemo(() => (tl ? new HighlightIndex(tl.spans) : null), [tl]);
  // khuông thuộc bè: [khuông đầu, số khuông] theo thứ tự trong hệ thống
  const partStaff = useMemo(() => {
    const m = new Map<string, [number, number]>();
    let at = 0;
    for (const p of project?.score.parts ?? []) {
      const n = Math.max(1, p.staves.length);
      m.set(p.id, [at, n]);
      at += n;
    }
    return m;
  }, [project]);

  // ---- mỗi khung hình: tìm nốt đang vang → làm sáng đầu nốt trên ảnh gốc
  useEffect(() => {
    if (!tl || !hi || !project || !sheet) return;
    let raf = 0;
    let lastKey = '';
    let lastSystem = -1;
    const aspectOf = (page: number) => {
      const pg = sheet.pages[page];
      return pg && pg.width ? pg.height / pg.width : 1.414;
    };
    const frame = () => {
      const tick = playbackPosition();
      const status = usePlayback.getState().status;
      const active = status === 'playing' || tick > 0 ? hi.activeAt(tick) : [];
      const keys = new Set<string>();
      let fallback: { page: number; x: number; y: number; h: number } | null = null;
      let focus: { page: number; y: number; system: number } | null = null;
      for (const s of active) {
        const pm = measureAtTick(tl, s.startTick);
        if (!pm) continue;
        const g = byMeasure.get(pm.measureIndex);
        if (!g) continue;
        focus ??= { page: g.page, y: g.y, system: g.system };
        if (!g.heads?.length) {
          const now = measureAtTick(tl, tick);
          if (now) fallback = { page: g.page, x: cursorX(g, tick - now.startTick, measureTicks(project.score, g.measureIndex)), y: g.y, h: g.h };
          continue;
        }
        const [first, n] = partStaff.get(s.partId) ?? [0, 99];
        for (let st = first; st < first + n; st++) keys.add(`${pm.measureIndex}|${s.startTick - pm.startTick}|${st}`);
      }
      const key = [...keys].sort().join(',');
      if (key !== lastKey) {
        lastKey = key;
        const perPage = new Map<number, string[]>();
        for (const k of keys) {
          const [mi, rel, st] = k.split('|').map(Number);
          const g = byMeasure.get(mi!);
          if (!g?.heads) continue;
          const a = aspectOf(g.page);
          for (const h of g.heads) {
            if (h[0] !== rel || h[1] !== st) continue;
            const pad = h[4] * 0.35;
            const list = perPage.get(g.page) ?? [];
            list.push(`<ellipse cx="${h[2] + h[4] / 2}" cy="${(h[3] + h[5] / 2) * a}" rx="${h[4] / 2 + pad}" ry="${(h[5] / 2) * a + pad}" />`);
            perPage.set(g.page, list);
          }
        }
        for (const [page, layer] of layers.current) layer.innerHTML = (perPage.get(page) ?? []).join('');
      }
      for (const [page, line] of cursors.current) {
        if (fallback && fallback.page === page) {
          const a = aspectOf(page);
          line.setAttribute('x1', String(fallback.x));
          line.setAttribute('x2', String(fallback.x));
          line.setAttribute('y1', String(fallback.y * a));
          line.setAttribute('y2', String((fallback.y + fallback.h) * a));
          line.style.display = '';
        } else line.style.display = 'none';
      }
      // tự cuộn theo dòng nhạc đang phát
      if (focus && status === 'playing' && focus.system !== lastSystem) {
        lastSystem = focus.system;
        const el = pageEls.current.get(focus.page);
        const host = wrap.current;
        if (el && host) {
          const top = el.offsetTop + focus.y * el.clientHeight - 80;
          if (top < host.scrollTop || top > host.scrollTop + host.clientHeight - 200) {
            host.scrollTo({ top, behavior: useStore.getState().reducedMotion ? 'auto' : 'smooth' });
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [tl, hi, project, sheet, byMeasure, partStaff]);

  // ---- chọn nốt bằng cách bấm đầu nốt: chọn các nốt bắt đầu tại phách đó (đúng bè/khuông), Play phát từ đó
  const selIds = useStore((s) => s.selection.noteIds);
  const selectedKeys = useMemo(() => {
    const out = new Set<string>();
    if (!tl || !selIds.length) return out;
    for (const sp of tl.spans) {
      if (!selIds.includes(sp.noteId)) continue;
      const pm = measureAtTick(tl, sp.startTick);
      const [first, n] = partStaff.get(sp.partId) ?? [0, 99];
      if (pm) for (let st = first; st < first + n; st++) out.add(`${pm.measureIndex}|${sp.startTick - pm.startTick}|${st}`);
    }
    return out;
  }, [tl, selIds, partStaff]);
  const pickHead = (mi: number, rel: number, staff: number) => {
    if (!tl) return;
    const pm = tl.measures.find((m) => m.measureIndex === mi);
    if (!pm) return;
    const tick = pm.startTick + rel;
    const ids = tl.spans
      .filter((sp) => sp.startTick === tick && (() => { const [f, n] = partStaff.get(sp.partId) ?? [0, 99]; return staff >= f && staff < f + n; })())
      .map((sp) => sp.noteId);
    useStore.getState().select({ noteIds: ids, eventIds: [] });
    markSelectionPlayed(ids);
    const pb = usePlayback.getState();
    pb.seek(tick);
    if (pb.status === 'playing') void pb.play(tick);
  };

  const waiting = usePlayback((x) => x.waiting);
  if (!project || !sheet) return null;
  const width = Math.max(320, Math.min(avail, 1100) * zoom);
  const seekTo = (mi: number) => {
    const m = tl?.measures.find((x) => x.measureIndex === mi);
    if (m) usePlayback.getState().seek(m.startTick);
  };
  const pending = sheet.pending;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 h-10 border-b border-line bg-surface text-[12px]">
        <span className="font-medium truncate max-w-64">Bản gốc: {sheet.fileName}</span>
        {pending && !pending.error ? (
          <span className="flex items-center gap-2 text-muted min-w-0">
            <span className="h-3 w-3 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" aria-hidden />
            <span className="truncate">
              Đang nhận dạng{pending.total > 1 ? ` · xong ${pending.done}/${pending.total} trang` : ''}{stage ? ` · ${OMR_STEPS[Math.min(stage, 10) - 1]}` : ''}
              {pending.partial ? ' · đã phát được dòng nhạc đầu tiên' : pending.done > 0 ? ' · đã phát được phần đã nhận dạng' : ''}
              {waiting ? ' · đang chờ phần tiếp theo để phát tiếp…' : ''}
            </span>
          </span>
        ) : pending?.error ? (
          <span className="text-warn truncate">Không nhận dạng được: {pending.error}</span>
        ) : (
          <span className="text-muted">{sheet.pages.length} trang · {sheet.measures.length || project.score.measures.length} ô nhịp</span>
        )}
        <label className="flex items-center gap-1.5 text-muted ml-2 shrink-0">
          <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} /> Khung ô nhịp
        </label>
        <div className="flex-1" />
        {sheet.mode === 'overlay' ? (
          <button className="h-7 px-3 rounded-md bg-accent text-accent-fg font-semibold disabled:opacity-40 shrink-0" disabled={!!pending} onClick={() => setConvert(true)}>Chuyển sang Editor</button>
        ) : (
          <button className="h-7 px-3 rounded-md border border-line hover:bg-surface-2 shrink-0" onClick={() => useStore.getState().setTab('editor')}>Mở Score Editor</button>
        )}
      </div>
      <div ref={wrap} className="relative flex-1 overflow-auto bg-surface-2 py-6">
        {!asset && (
          <p className="mx-auto max-w-lg text-center text-muted text-[13px] mt-10">
            Không có file ảnh/PDF gốc trong phiên này (bản tự lưu không kèm file gốc). Hãy mở file <b>.holymelody</b> đã lưu hoặc mở lại file gốc.
          </p>
        )}
        {asset && sheet.pages.map((pg, i) => (
          <SheetPageView
            key={i} index={i} page={pg} asset={asset} width={width} sheet={sheet} showBoxes={showBoxes} onSeek={seekTo}
            selectedKeys={selectedKeys} onPickHead={pickHead}
            measureIds={project.score.measures.map((m) => m.id)}
            pageRef={(el) => { if (el) pageEls.current.set(i, el); else pageEls.current.delete(i); }}
            layerRef={(el) => { if (el) layers.current.set(i, el); else layers.current.delete(i); }}
            cursorRef={(el) => { if (el) cursors.current.set(i, el); else cursors.current.delete(i); }}
          />
        ))}
        {asset && !pending && !sheet.measures.length && (
          <p className="mx-auto max-w-lg text-center text-muted text-[12px] mt-2">Audiveris không trả về tọa độ cho file này: vẫn phát được, nhưng không làm sáng nốt trên ảnh.</p>
        )}
      </div>
      {convert && <ConvertDialog onClose={() => setConvert(false)} />}
    </div>
  );
}

function SheetPageView(props: {
  index: number; page: SheetSource['pages'][number]; asset: SheetAsset; width: number; sheet: SheetSource;
  showBoxes: boolean; onSeek: (mi: number) => void; measureIds: string[];
  selectedKeys: Set<string>; onPickHead: (mi: number, rel: number, staff: number) => void;
  pageRef: (el: HTMLDivElement | null) => void; layerRef: (el: SVGGElement | null) => void; cursorRef: (el: SVGLineElement | null) => void;
}) {
  const { index, page, asset, width, sheet, showBoxes, onSeek, measureIds, pageRef, layerRef, cursorRef, selectedKeys, onPickHead } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const aspect = page.width && page.height ? page.height / page.width : 1.414;
  const height = width * aspect;

  useEffect(() => {
    if (asset.kind !== 'pdf' || !canvas.current) return;
    // vẽ lại vector khi đổi kích thước (trễ một chút để không vẽ liên tục lúc kéo zoom)
    const t = setTimeout(() => void renderPdfPage(asset, index, canvas.current!, width).catch(() => undefined), 120);
    return () => clearTimeout(t);
  }, [asset, index, width]);

  const measures = sheet.measures.filter((g) => g.page === index);
  return (
    <div ref={pageRef} className="relative mx-auto mb-6 bg-white shadow-md" style={{ width, height }}>
      {/* dạo đầu + đếm vào: ngay phía trên dòng nhạc đầu tiên của bản gốc */}
      {index === 0 && measures[0] && <CountIn left={measures[0].x * width} top={measures[0].y * height} />}
      {asset.kind === 'pdf' ? (
        <canvas ref={canvas} style={{ width, height }} className="block" aria-label={`Trang ${index + 1}`} />
      ) : (
        <img src={imageUrl(asset)} alt={`Trang ${index + 1}`} style={{ width, height }} className="block select-none" draggable={false} />
      )}
      <svg className="absolute inset-0" width={width} height={height} viewBox={`0 0 1 ${aspect}`} preserveAspectRatio="none" aria-hidden>
        {measures.map((g) => {
          const id = measureIds[g.measureIndex];
          const flagged = sheet.mode === 'edit' && id && sheet.reviews[id]?.status === 'flagged';
          return (
            <rect
              key={g.measureIndex} x={g.x} y={g.y * aspect} width={g.w} height={g.h * aspect}
              fill={flagged ? 'rgba(214,120,60,.12)' : 'transparent'}
              stroke={showBoxes ? 'var(--accent)' : 'transparent'} strokeWidth={1} vectorEffect="non-scaling-stroke"
              className="cursor-pointer hover:fill-[var(--accent)] hover:[fill-opacity:.06]"
              onClick={() => onSeek(g.measureIndex)}
            >
              <title>Ô {g.measureIndex + 1} · bấm để phát từ đây</title>
            </rect>
          );
        })}
        {/* đầu nốt bấm được: chọn nốt → Play phát từ nốt đó */}
        {measures.flatMap((g) => (g.heads ?? []).map((h, k) => {
          const sel = selectedKeys.has(`${g.measureIndex}|${h[0]}|${h[1]}`);
          return (
            <ellipse
              key={`${g.measureIndex}-${k}`} cx={h[2] + h[4] / 2} cy={(h[3] + h[5] / 2) * aspect} rx={h[4] * 0.85} ry={h[5] * aspect * 0.85}
              className={`hm-sheet-head ${sel ? 'hm-sheet-head-sel' : ''}`} vectorEffect="non-scaling-stroke"
              onClick={(e) => { e.stopPropagation(); onPickHead(g.measureIndex, h[0], h[1]); }}
            >
              <title>Chọn nốt · bấm Play để phát từ đây</title>
            </ellipse>
          );
        }))}
        {/* đầu nốt đang vang: vẽ trực tiếp mỗi khung hình (không qua React) */}
        <g ref={layerRef} className="hm-sheet-notes" pointerEvents="none" />
        <line ref={cursorRef} y1={0} y2={0} stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ display: 'none' }} />
      </svg>
    </div>
  );
}
