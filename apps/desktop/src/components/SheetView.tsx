/**
 * Player cho bản nhạc mở từ ảnh/PDF: hiển thị trang gốc (PDF vẽ vector theo zoom) và lớp phủ nhận dạng
 * trong suốt để phát MIDI, tô sáng ô nhịp, con trỏ chạy theo nốt. Bấm vào ô nhịp để nhảy tới đó.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cursorX, measureAtTick, measureTicks, type SheetMeasureGeom, type SheetSource } from '@holy-melody/music-core';
import { useActiveProject, useStore } from '../state/store';
import { playbackPosition, usePlayback } from '../state/playback';
import { getSheetAsset, imageUrl, renderPdfPage, type SheetAsset } from '../lib/sheet';
import { ConvertDialog } from './ConvertDialog';

export function SheetView() {
  const project = useActiveProject();
  const zoom = useStore((s) => s.layout.zoom);
  const tl = useStore((s) => s.timeline);
  const [showBoxes, setShowBoxes] = useState(false);
  const [convert, setConvert] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(900);
  const [active, setActive] = useState<number | null>(null);
  const cursors = useRef(new Map<number, SVGLineElement>());

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - 48));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sheet = project?.score.sheet;
  const asset = project ? getSheetAsset(project.score.id) : undefined;
  const byMeasure = useMemo(() => new Map((sheet?.measures ?? []).map((g) => [g.measureIndex, g])), [sheet]);

  // ---- con trỏ phát: đọc vị trí mỗi khung hình, chỉ render lại React khi đổi ô nhịp
  useEffect(() => {
    if (!tl || !project) return;
    let raf = 0;
    let last: number | null = -1;
    const f = () => {
      const tick = playbackPosition();
      const pm = measureAtTick(tl, tick);
      const mi = pm?.measureIndex ?? null;
      if (mi !== last) {
        last = mi;
        setActive(mi);
      }
      const g = mi !== null ? byMeasure.get(mi) : undefined;
      for (const [page, line] of cursors.current) {
        if (g && g.page === page && pm) {
          const x = cursorX(g, tick - pm.startTick, measureTicks(project.score, g.measureIndex));
          const pg = project.score.sheet?.pages[page];
          const aspect = pg && pg.width ? pg.height / pg.width : 1.414;
          line.setAttribute('x1', String(x));
          line.setAttribute('x2', String(x));
          line.setAttribute('y1', String(g.y * aspect));
          line.setAttribute('y2', String((g.y + g.h) * aspect));
          line.style.display = '';
        } else line.style.display = 'none';
      }
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [tl, project, byMeasure]);

  if (!project || !sheet) return null;
  const measureIds = project.score.measures.map((m) => m.id);
  const width = Math.max(320, Math.min(avail, 1100) * zoom);
  const seekTo = (mi: number) => {
    const m = tl?.measures.find((x) => x.measureIndex === mi);
    if (m) usePlayback.getState().seek(m.startTick);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 h-10 border-b border-line bg-surface text-[12px]">
        <span className="font-medium truncate">Bản gốc: {sheet.fileName}</span>
        <span className="text-muted">{sheet.pages.length} trang · lớp nhận dạng {sheet.measures.length || project.score.measures.length} ô nhịp</span>
        <label className="flex items-center gap-1.5 text-muted ml-2">
          <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} /> Hiện khung ô nhịp
        </label>
        <div className="flex-1" />
        {sheet.mode === 'overlay' ? (
          <button className="h-7 px-3 rounded-md bg-accent text-accent-fg font-semibold" onClick={() => setConvert(true)}>Chuyển sang Edit · 10 credit</button>
        ) : (
          <button className="h-7 px-3 rounded-md border border-line hover:bg-surface-2" onClick={() => useStore.getState().setTab('editor')}>Mở Score Editor</button>
        )}
      </div>
      <div ref={wrap} className="flex-1 overflow-auto bg-surface-2 py-6">
        {!asset && (
          <p className="mx-auto max-w-lg text-center text-muted text-[13px] mt-10">
            Không có file ảnh/PDF gốc trong phiên này (bản tự lưu không kèm file gốc). Hãy mở file <b>.holymelody</b> đã lưu hoặc mở lại file gốc.
          </p>
        )}
        {asset && sheet.pages.map((pg, i) => (
          <SheetPageView
            key={i} index={i} page={pg} asset={asset} width={width} sheet={sheet}
            active={active} showBoxes={showBoxes} onSeek={seekTo} measureIds={measureIds}
            cursorRef={(el) => { if (el) cursors.current.set(i, el); else cursors.current.delete(i); }}
          />
        ))}
        {asset && !sheet.measures.length && (
          <p className="mx-auto max-w-lg text-center text-muted text-[12px] mt-2">Audiveris không trả về tọa độ ô nhịp cho file này: vẫn phát được, nhưng không tô sáng trên ảnh.</p>
        )}
      </div>
      {convert && <ConvertDialog onClose={() => setConvert(false)} />}
    </div>
  );
}

function SheetPageView(props: {
  index: number; page: SheetSource['pages'][number]; asset: SheetAsset; width: number; sheet: SheetSource;
  active: number | null; showBoxes: boolean; onSeek: (mi: number) => void; cursorRef: (el: SVGLineElement | null) => void;
  measureIds: string[];
}) {
  const { index, page, asset, width, sheet, active, showBoxes, onSeek, cursorRef, measureIds } = props;
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
  const fill = (g: SheetMeasureGeom) => {
    if (g.measureIndex === active) return 'var(--hl)';
    const id = measureIds[g.measureIndex];
    if (sheet.mode === 'edit' && id && sheet.reviews[id]?.status === 'flagged') return 'rgba(214,120,60,.14)';
    return 'transparent';
  };

  return (
    <div className="relative mx-auto mb-6 bg-white shadow-md" style={{ width, height }}>
      {asset.kind === 'pdf' ? (
        <canvas ref={canvas} style={{ width, height }} className="block" aria-label={`Trang ${index + 1}`} />
      ) : (
        <img src={imageUrl(asset)} alt={`Trang ${index + 1}`} style={{ width, height }} className="block select-none" draggable={false} />
      )}
      <svg className="absolute inset-0" width={width} height={height} viewBox={`0 0 1 ${aspect}`} preserveAspectRatio="none" aria-hidden>
        {measures.map((g) => (
          <rect
            key={g.measureIndex} x={g.x} y={g.y * aspect} width={g.w} height={g.h * aspect}
            fill={fill(g)} fillOpacity={g.measureIndex === active ? 0.35 : 1}
            stroke={showBoxes ? 'var(--accent)' : 'transparent'} strokeWidth={1} vectorEffect="non-scaling-stroke"
            className="cursor-pointer hover:fill-[var(--accent)] hover:[fill-opacity:.08]"
            onClick={() => onSeek(g.measureIndex)}
          >
            <title>Ô {g.measureIndex + 1} · bấm để phát từ đây</title>
          </rect>
        ))}
        <line ref={cursorRef} y1={0} y2={0} stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ display: 'none' }} />
      </svg>
    </div>
  );
}
