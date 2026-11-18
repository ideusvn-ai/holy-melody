/**
 * Hiển thị bản nhạc (renderer cơ bản Phase 1) + highlight theo audio clock + chọn nốt/ô nhịp.
 * Highlight thao tác trực tiếp trên DOM qua id ổn định (không re-render React mỗi frame).
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import { durationTicks, HighlightIndex, keyFifthsAt, measureAtTick, measureTicks, pitchFromStaffStep, pitchToMidi, placeNote, setLyricStyle, type Pitch } from '@holy-melody/music-core';
import { HEAD_W, layoutScore, type EventBox, type ScoreLayout } from '@holy-melody/score-renderer';
import type { ScoreDocument } from '@holy-melody/music-core';
import { useActiveProject, useStore } from '../state/store';
import { CountIn } from './CountIn';
import { playbackPosition, usePlayback } from '../state/playback';

interface Props {
  /** cho phép chọn nốt để chỉnh sửa */
  editable?: boolean;
  /** id nốt được Trợ lý soạn nhạc đánh dấu */
  flaggedNoteIds?: string[];
}


export function ScoreView({ editable = false, flaggedNoteIds = [] }: Props) {
  const project = useActiveProject();
  const revision = useStore((s) => s.revision);
  const timeline = useStore((s) => s.timeline);
  const zoom = useStore((s) => s.layout.zoom);
  const selection = useStore((s) => s.selection);
  const preview = useStore((s) => s.harmonyPreview);
  const unverifiedIds = project?.score.provenance.unverifiedEventIds;
  const unverified = useMemo(() => new Set(unverifiedIds ?? []), [unverifiedIds, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const select = useStore((s) => s.select);
  const status = usePlayback((s) => s.status);
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cursorRef = useRef<SVGRectElement>(null);
  const [width, setWidth] = useState(900);
  const dragStart = useRef<number | null>(null);
  const noteInput = useStore((s) => s.noteInput);
  const inputDuration = useStore((s) => s.inputDuration);
  const [lyricDrag, setLyricDrag] = useState<{ y: number; dy: number } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; staffY: number; steps: number; pitch: Pitch } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(480, Math.min(1400, e!.contentRect.width - 48))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () => (project ? layoutScore(preview ? { ...project.score, chordSymbols: preview } : project.score, { width: width / zoom, sp: 8 }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.id, revision, width, zoom, preview],
  );
  const hiIndex = useMemo(() => (timeline ? new HighlightIndex(timeline.spans) : null), [timeline]);

  // ---- vòng highlight theo audio clock
  useEffect(() => {
    if (!layout || !hiIndex || !timeline) return;
    let raf = 0;
    let lit: Element[] = [];
    let lastSystem = -1;
    const frame = () => {
      const tick = playbackPosition();
      const active = status === 'playing' || tick > 0 ? hiIndex.activeAt(tick) : [];
      const svg = svgRef.current;
      if (svg) {
        for (const el of lit) el.classList.remove('hm-playing');
        lit = [];
        for (const s of active) {
          const el = svg.getElementById(s.noteId);
          if (el) {
            el.classList.add('hm-playing');
            lit.push(el);
          }
        }
        // con trỏ phát theo ô nhịp hiện tại
        const pm = measureAtTick(timeline, tick);
        const mb = pm && layout.measures.get(pm.measureId);
        const cur = cursorRef.current;
        if (mb && cur) {
          const sys = layout.systems[mb.systemIndex]!;
          const frac = (tick - pm.startTick) / Math.max(1, pm.endTick - pm.startTick);
          cur.setAttribute('x', String(mb.x + frac * mb.width));
          cur.setAttribute('y', String(sys.y - 12));
          cur.setAttribute('height', String(sys.height + 24));
          cur.style.opacity = '0'; // chỉ làm sáng nốt đang phát, không vẽ vạch qua cả khuông
          if (status === 'playing' && sys.index !== lastSystem) {
            lastSystem = sys.index;
            const host = hostRef.current;
            if (host) host.scrollTo({ top: sys.y * zoom - 80, behavior: useStore.getState().reducedMotion ? 'auto' : 'smooth' });
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [layout, hiIndex, timeline, status, zoom]);

  if (!project || !layout) {
    return <div className="flex-1 grid place-items-center text-muted">Chưa mở bản nhạc nào</div>;
  }
  const { sp } = layout;
  const staffH = sp * 4;
  const selNotes = new Set([...selection.noteIds, ...selection.eventIds]); // gồm cả dấu lặng đang chọn
  const flagged = new Set(flaggedNoteIds);
  const [selFrom, selTo] = selection.measureRange ?? [-1, -2];

  const onNoteClick = (e: RMouseEvent, noteId: string, eventId: string) => {
    e.stopPropagation();
    // bấm vào dấu lặng (noteId rỗng) khi đang nhập nốt: đặt nốt ngay tại đó
    if (!noteId && onInputClick(e)) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      select({ noteIds: [...new Set([...selection.noteIds, ...(noteId ? [noteId] : [])])], eventIds: [...new Set([...selection.eventIds, eventId])], measureRange: undefined });
    } else {
      select({ noteIds: noteId ? [noteId] : [], eventIds: [eventId], measureRange: undefined });
    }
    if (!editable && e.detail === 2 && hiIndex) {
      const t = hiIndex.firstTickOf(noteId);
      if (t !== undefined) void usePlayback.getState().play(t); // nhấp đúp: phát từ nốt này
    }
  };

  // ---- nhập nốt: bấm lên khuông → đặt nốt (ghi đè dấu lặng), nốt mờ chạy theo chuột
  const inputOn = editable && noteInput;
  const locate = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    let best: { st: (typeof layout.systems)[number]['staves'][number]; sys: (typeof layout.systems)[number]; d: number } | null = null;
    for (const sys of layout.systems) {
      for (const st of sys.staves) {
        if (p.y < st.y - sp * 3.5 || p.y > st.y + sp * 7.5) continue;
        const d = Math.abs(p.y - (st.y + sp * 2));
        if (!best || d < best.d) best = { st, sys, d };
      }
    }
    if (!best) return null;
    const { st, sys } = best;
    const mb = sys.measures.find((m) => p.x >= m.x && p.x < m.x + m.width);
    if (!mb) return null;
    const steps = Math.max(-8, Math.min(16, Math.round((st.y + sp * 4 - p.y) / (sp / 2))));
    const score = project.score;
    const pitch = pitchFromStaffStep(st.clef, steps, keyFifthsAt(score, mb.index));
    const evs = layout.events
      .filter((e) => e.measureIndex === mb.index && e.partId === st.partId && e.event.staff === st.staffIndex && !(e.event.kind === 'chord' && e.event.grace))
      .sort((a, b) => a.start - b.start);
    const voice = evs[0]?.voice ?? (st.staffIndex === 0 ? 1 : 5);
    const own = evs.filter((e) => e.voice === voice);
    const total = measureTicks(score, mb.index);
    const unit = Math.max(60, Math.min(durationTicks(inputDuration), total));
    let tick = 0;
    let gx = mb.x + sp * 1.5;
    const baseIdx = own.reduce((acc, e, i) => (e.x - sp * 0.9 <= p.x ? i : acc), -1);
    if (baseIdx >= 0) {
      const b = own[baseIdx]!;
      const nextX = own[baseIdx + 1]?.x ?? mb.x + mb.width - sp;
      const nextStart = own[baseIdx + 1]?.start ?? total;
      const span = nextStart - b.start;
      // trong một dấu lặng/nốt dài: bắt vào lưới theo trường độ đang chọn
      const frac = Math.max(0, Math.min(0.999, (p.x - b.x + sp * 0.5) / Math.max(sp, nextX - b.x)));
      tick = b.event.kind === 'rest' && span > unit ? b.start + Math.floor((frac * span) / unit) * unit : b.start;
      gx = b.x + ((tick - b.start) / Math.max(1, span)) * (nextX - b.x);
    } else if (own.length === 0) {
      const frac = Math.max(0, Math.min(0.999, (p.x - mb.x) / mb.width));
      tick = Math.floor((frac * total) / unit) * unit;
      gx = mb.x + sp * 1.5 + (tick / total) * (mb.width - sp * 3);
    }
    return { partId: st.partId, staff: st.staffIndex, voice, measureIndex: mb.index, tick, pitch, x: gx, y: st.y + sp * 4 - (steps * sp) / 2, staffY: st.y, steps };
  };
  // ---- tay nắm trước dòng lời ca: kéo lên/xuống để chỉnh khoảng cách lời ca – khuông (xem trước trực tiếp)
  const lyricHandles = (() => {
    if (!editable) return [];
    const bySys = new Map<number, number>();
    for (const e of layout.events) {
      const y = e.lyrics.find((l) => l.verse === Math.min(...e.lyrics.map((x) => x.verse)))?.y;
      if (y === undefined) continue;
      const cur = bySys.get(e.systemIndex);
      if (cur === undefined || y < cur) bySys.set(e.systemIndex, y);
    }
    return [...bySys].map(([system, y]) => ({ system, y: y - layout.lyricStyle.fontPx * 0.35, x: layout.marginX - sp * 1.6 }));
  })();
  const startLyricDrag = (e: RMouseEvent, y: number) => {
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY;
    const start = project.score.layout.lyricOffsetSp ?? 3;
    const svg = svgRef.current;
    let dy = 0;
    const move = (ev: MouseEvent) => {
      const raw = (ev.clientY - y0) / zoom;
      const next = Math.max(0.5, Math.min(12, start + raw / sp));
      dy = (next - start) * sp;
      svg?.style.setProperty('--lyr-dy', `${dy}px`);
      setLyricDrag({ y, dy });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      svg?.style.removeProperty('--lyr-dy');
      setLyricDrag(null);
      const next = Math.round((start + dy / sp) * 4) / 4;
      if (next !== start) useStore.getState().exec(setLyricStyle({ lyricOffsetSp: next }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const onInputMove = (e: RMouseEvent) => {
    if (!inputOn) return;
    setGhost(locate(e.clientX, e.clientY));
  };
  const onInputClick = (e: RMouseEvent) => {
    if (!inputOn) return false;
    const t = locate(e.clientX, e.clientY);
    if (!t) return false;
    const cmd = placeNote({ partId: t.partId, measureIndex: t.measureIndex, voice: t.voice, staff: t.staff, tick: t.tick, pitch: t.pitch, duration: inputDuration, addToChord: e.shiftKey });
    useStore.getState().exec(cmd);
    if (cmd.result.noteId) select({ noteIds: [cmd.result.noteId], eventIds: cmd.result.eventId ? [cmd.result.eventId] : [], measureRange: undefined });
    usePlayback.getState().engine.previewNote(pitchToMidi(t.pitch));
    return true;
  };

  const onMeasureDown = (e: RMouseEvent, index: number) => {
    if (inputOn) return; // chế độ nhập nốt: bấm để đặt nốt, không chọn ô
    dragStart.current = index;
    if (e.shiftKey && selection.measureRange) {
      const a = Math.min(selection.measureRange[0], index);
      const b = Math.max(selection.measureRange[1], index);
      select({ measureRange: [a, b], noteIds: [], eventIds: [] });
    } else {
      select({ measureRange: [index, index], noteIds: [], eventIds: [] });
    }
  };
  const onMeasureEnter = (index: number) => {
    if (dragStart.current === null) return;
    const a = Math.min(dragStart.current, index);
    const b = Math.max(dragStart.current, index);
    select({ measureRange: [a, b], noteIds: [], eventIds: [] });
  };

  return (
    <div
      ref={hostRef}
      className="flex-1 overflow-auto bg-surface-2"
      onMouseUp={() => (dragStart.current = null)}
      onMouseLeave={() => (dragStart.current = null)}
    >
      <div className="relative mx-auto my-6 hm-paper rounded-md shadow-[0_1px_3px_rgb(0_0_0/0.12),0_8px_24px_rgb(0_0_0/0.08)]" style={{ width: layout.width * zoom }}>
        {/* dạo đầu + đếm vào: ngay phía trên dòng nhạc đầu tiên (chỉ khi nghe ở Player) */}
        {!editable && layout.systems[0]?.staves[0] && (
          <CountIn left={layout.marginX * zoom} top={(layout.systems[0].staves[0].y - sp * 3.2) * zoom} />
        )}
        <svg
          ref={svgRef}
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`Bản nhạc ${project.score.meta.title}`}
          onClick={(e) => { if (!onInputClick(e)) select({ noteIds: [], eventIds: [], measureRange: undefined }); }}
          onMouseMove={onInputMove}
          onMouseLeave={() => setGhost(null)}
          style={inputOn ? { cursor: 'crosshair' } : undefined}
        >
          <ScoreSvgBody
            layout={layout}
            score={project.score}
            selNotes={selNotes}
            flagged={flagged}
            selRange={[selFrom, selTo]}
            previewChords={!!preview}
            unverified={unverified}
            onNoteClick={onNoteClick}
            onMeasureDown={onMeasureDown}
            onMeasureEnter={onMeasureEnter}
            onMeasureClick={(e) => void onInputClick(e)}
          />
          {editable && lyricHandles.map((h) => (
            <g key={h.system} className="hm-lyric-handle" transform={`translate(${h.x} ${h.y})`} onMouseDown={(e) => startLyricDrag(e, h.y)} onClick={(e) => e.stopPropagation()}>
              <title>Kéo lên/xuống để chỉnh vị trí lời ca</title>
              <rect x={-sp * 0.9} y={-sp * 1.1} width={sp * 1.8} height={sp * 1.6} rx={sp * 0.35} />
              {[-0.6, -0.3, 0].map((d) => <line key={d} x1={-sp * 0.45} x2={sp * 0.45} y1={d * sp - sp * 0.05} y2={d * sp - sp * 0.05} />)}
            </g>
          ))}
          {lyricDrag && <line x1={layout.marginX} x2={layout.width - layout.marginX} y1={lyricDrag.y + lyricDrag.dy} y2={lyricDrag.y + lyricDrag.dy} stroke="var(--accent)" strokeDasharray="4 3" pointerEvents="none" />}
          {inputOn && ghost && (
            <g pointerEvents="none" className="hm-ghost">
              {Array.from({ length: Math.max(0, Math.floor((-ghost.steps) / 2)) }, (_, i) => (
                <line key={`b${i}`} x1={ghost.x - sp * 1.1} x2={ghost.x + sp * 1.1} y1={ghost.staffY + sp * 5 + i * sp} y2={ghost.staffY + sp * 5 + i * sp} />
              ))}
              {Array.from({ length: Math.max(0, Math.floor((ghost.steps - 8) / 2)) }, (_, i) => (
                <line key={`t${i}`} x1={ghost.x - sp * 1.1} x2={ghost.x + sp * 1.1} y1={ghost.staffY - sp - i * sp} y2={ghost.staffY - sp - i * sp} />
              ))}
              <ellipse cx={ghost.x} cy={ghost.y} rx={sp * 0.66} ry={sp * 0.47} transform={`rotate(-20 ${ghost.x} ${ghost.y})`} />
              <text x={ghost.x + sp * 1.2} y={ghost.y - sp * 0.9} fontSize={sp * 1.1}>{ghost.pitch.step}{ghost.pitch.alter > 0 ? '♯' : ghost.pitch.alter < 0 ? '♭' : ''}{ghost.pitch.octave}</text>
            </g>
          )}
          <rect ref={cursorRef} className="hm-cursor" x={0} y={0} width={2} height={0} fill="var(--hl)" opacity={0} pointerEvents="none" rx={1} />
        </svg>
      </div>
    </div>
  );
}

export interface ScoreSvgBodyProps {
  layout: ScoreLayout;
  score: ScoreDocument;
  selNotes?: Set<string>;
  flagged?: Set<string>;
  selRange?: [number, number];
  previewChords?: boolean;
  unverified?: Set<string>;
  onNoteClick?: (e: RMouseEvent, noteId: string, eventId: string) => void;
  onMeasureDown?: (e: RMouseEvent, index: number) => void;
  onMeasureEnter?: (index: number) => void;
  /** bấm vào nền ô nhịp (chế độ nhập nốt: đặt nốt) */
  onMeasureClick?: (e: RMouseEvent) => void;
}

/** Phần thân SVG của bản nhạc – dùng chung cho màn hình, trang in/PDF và xuất SVG/PNG */
export function ScoreSvgBody({
  layout, score, selNotes = new Set(), flagged = new Set(), selRange = [-1, -2], previewChords = false, unverified = new Set(),
  onNoteClick = () => {}, onMeasureDown = () => {}, onMeasureEnter = () => {}, onMeasureClick = () => {},
}: ScoreSvgBodyProps) {
  const { sp } = layout;
  const staffH = sp * 4;
  const [selFrom, selTo] = selRange;
  return (
    <>
      {score.meta.title && (
        <g>
          <text x={layout.width / 2} y={layout.marginX * 0.6 + 26} textAnchor="middle" fontSize={22} fontWeight={600} fill="currentColor" fontFamily="Georgia, 'Times New Roman', serif">{score.meta.title}</text>
          {score.meta.composer && <text x={layout.width - layout.marginX} y={layout.marginX * 0.6 + 56} textAnchor="end" fontSize={11} fill="currentColor">{score.meta.composer}</text>}
        </g>
      )}
      {layout.systems.map((sys) => (
        <g key={sys.index}>
          {/* nền ô nhịp để chọn */}
          {sys.measures.map((mb) => (
            <rect
              key={mb.measureId}
              className={`hm-measure-bg ${mb.index >= selFrom && mb.index <= selTo ? 'hm-selected' : ''}`}
              x={mb.x} y={sys.y - sp * 2} width={mb.width} height={sys.height + sp * 4}
              onMouseDown={(e) => onMeasureDown(e, mb.index)}
              onMouseEnter={() => onMeasureEnter(mb.index)}
              onClick={(e) => { e.stopPropagation(); onMeasureClick(e); }}
            />
          ))}
          {sys.staves.map((st, si) => {
            const x0 = layout.marginX;
            const x1 = sys.measures[sys.measures.length - 1]!.x + sys.measures[sys.measures.length - 1]!.width;
            return (
              <g key={si} pointerEvents="none">
                {[0, 1, 2, 3, 4].map((l) => <line key={l} x1={x0} x2={x1} y1={st.y + l * sp} y2={st.y + l * sp} stroke="currentColor" strokeWidth={0.8} />)}
                {/* SMuFL: 1 em = 4 khoảng dòng kẻ; gốc khoá Sol ở dòng 2, khoá Fa ở dòng 4, khoá Đô ở dòng giữa */}
                <text x={x0 + sp * 0.6} y={st.y + (st.clef.sign === 'F' ? sp : st.clef.sign === 'C' ? sp * 2 : sp * 3)} fontSize={sp * 4} fontFamily="Bravura" fill="currentColor">
                  {st.clef.sign === 'F' ? '\uE062' : st.clef.sign === 'C' ? '\uE05C' : '\uE050'}
                </text>
                {st.clef.octaveChange === -1 && <text x={x0 + sp * 1.3} y={st.y + sp * 6.3} fontSize={9} fill="currentColor" fontStyle="italic">8</text>}
                <KeySig x={x0 + sp * 3.6} y={st.y} sp={sp} fifths={sys.keyFifths} clef={st.clef.sign} />
                {sys.timeSig && (
                  <g fontSize={sp * 4} fontFamily="Bravura" textAnchor="middle" fill="currentColor">
                    <text x={x0 + sp * 4.9 + Math.abs(sys.keyFifths) * sp * 1.05} y={st.y + sp}>{smuflDigits(sys.timeSig.beats)}</text>
                    <text x={x0 + sp * 4.9 + Math.abs(sys.keyFifths) * sp * 1.05} y={st.y + sp * 3}>{smuflDigits(sys.timeSig.beatType)}</text>
                  </g>
                )}
                {sys.measures.map((mb) => {
                  const m = score.measures[mb.index]!;
                  const xr = mb.x + mb.width;
                  return (
                    <g key={mb.measureId}>
                      {si === 0 && <text x={mb.x + 2} y={st.y - sp * 0.8} fontSize={9} fill="var(--muted)">{m.number}</text>}
                      {m.repeatStart && <RepeatDots x={mb.x + 6} y={st.y} sp={sp} />}
                      {m.repeatEnd && <RepeatDots x={xr - 8} y={st.y} sp={sp} />}
                      <line x1={xr} x2={xr} y1={st.y} y2={st.y + staffH} stroke="currentColor" strokeWidth={m.barlineRight === 'final' || m.repeatEnd ? 1 : 0.9} />
                      {(m.barlineRight === 'final' || m.repeatEnd) && <rect x={xr - 4} y={st.y} width={3.2} height={staffH} fill="currentColor" />}
                      {m.barlineRight === 'double' && <line x1={xr - 3} x2={xr - 3} y1={st.y} y2={st.y + staffH} stroke="currentColor" />}
                      {si === 0 && m.volta && (
                        <g>
                          <path d={`M${mb.x + 2} ${st.y - sp * 2} V${st.y - sp * 3.4} H${xr - 4}`} stroke="currentColor" fill="none" strokeWidth={0.9} />
                          <text x={mb.x + 5} y={st.y - sp * 2.3} fontSize={10}>{m.volta.numbers.join(', ')}.</text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
          {sys.staves.length > 1 && <line x1={layout.marginX} x2={layout.marginX} y1={sys.y} y2={sys.y + sys.height} stroke="currentColor" strokeWidth={1.2} />}
        </g>
      ))}
      {layout.chordSymbols.map((c) => (
        <text key={c.id} x={c.x} y={c.y} fontSize={12} fontWeight={600} fill={previewChords ? 'var(--info)' : 'currentColor'} fontFamily="Georgia, serif">{c.text}</text>
      ))}
      <Decorations layout={layout} />
      {layout.events.map((ev) => (
        <EventGlyph key={ev.event.id} box={ev} sp={sp} lyric={layout.lyricStyle} unverified={unverified.has(ev.event.id)} selNotes={selNotes} flagged={flagged} onNoteClick={onNoteClick} />
      ))}
    </>
  );
}

function RepeatDots({ x, y, sp }: { x: number; y: number; sp: number }) {
  return (
    <g fill="currentColor">
      <circle cx={x} cy={y + sp * 1.5} r={1.6} />
      <circle cx={x} cy={y + sp * 2.5} r={1.6} />
    </g>
  );
}

/** Mã SMuFL (font Bravura) */
const SMUFL_ACC: Record<string, string> = { '𝄫': '\uE264', '♭': '\uE260', '♮': '\uE261', '♯': '\uE262', '𝄪': '\uE263' };
const SMUFL_REST: Record<string, string> = {
  whole: '\uE4E3', half: '\uE4E4', quarter: '\uE4E5', eighth: '\uE4E6', '16th': '\uE4E7', '32nd': '\uE4E8', '64th': '\uE4E9',
};
const smuflDigits = (n: number) => String(n).split('').map((d) => String.fromCharCode(0xe080 + Number(d))).join('');

function KeySig({ x, y, sp, fifths, clef }: { x: number; y: number; sp: number; fifths: number; clef: string }) {
  // vị trí (nửa khoảng tính từ dòng dưới) cho khóa Sol; khóa Fa thấp hơn 2 bậc
  const sharps = [8, 5, 9, 6, 3, 7, 4];
  const flats = [4, 7, 3, 6, 2, 5, 1];
  const shift = clef === 'F' ? -2 : 0;
  const list = fifths > 0 ? sharps.slice(0, fifths) : flats.slice(0, -fifths);
  return (
    <g fontSize={sp * 4} fill="currentColor" fontFamily="Bravura">
      {list.map((pos, i) => (
        <text key={i} x={x + i * sp * 1.05} y={y + sp * 4 - ((pos + shift) * sp) / 2}>{fifths > 0 ? '\uE262' : '\uE260'}</text>
      ))}
    </g>
  );
}

function EventGlyph({ box, sp, selNotes, flagged, onNoteClick, lyric, unverified }: {
  box: EventBox; sp: number; lyric: { fontPx: number; family: string; italicVerses: number[] }; unverified?: boolean; selNotes: Set<string>; flagged: Set<string>;
  onNoteClick: (e: RMouseEvent, noteId: string, eventId: string) => void;
}) {
  const ev = box.event;
  const staffBottom = box.staffY + sp * 4;
  if (ev.kind === 'rest') {
    if (ev.hidden) return null;
    // nhiều bè trên một khuông: dấu lặng bè 1 nâng lên, bè 2 hạ xuống để không đè nốt bè kia
    const vdy = box.multiVoice && !ev.measureRest ? (box.voice % 2 === 1 ? -sp * 2 : sp * 2) : 0;
    const mid = box.staffY + sp * 2 + vdy;
    const t = ev.measureRest ? 'whole' : ev.duration.type;
    return (
      <g id={ev.id} fill="currentColor" className={`hm-rest ${selNotes.has(ev.id) ? 'hm-selected' : ''}`} onClick={(e) => onNoteClick(e, '', ev.id)}>
        <rect x={box.x - sp * 0.4} y={box.staffY} width={sp * 2} height={sp * 4} fill="transparent" />
        {/* dấu lặng SMuFL: lặng tròn treo dưới dòng 4, các dấu khác đặt trên dòng giữa */}
        <text x={box.x} y={t === 'whole' ? box.staffY + sp + vdy : mid} fontSize={sp * 4} fontFamily="Bravura">{SMUFL_REST[t] ?? SMUFL_REST.quarter}</text>
        {ev.duration.dots > 0 && <circle cx={box.x + sp * 1.9} cy={mid - sp * 0.5} r={1.4} />}
      </g>
    );
  }
  const heads = box.heads;
  if (!heads.length) return null;
  const filled = heads[0]!.filled;
  const hasStem = ev.duration.type !== 'whole';
  const stemX = box.stemX;
  const stemY1 = box.stemUp ? Math.max(...heads.map((h) => h.y)) : Math.min(...heads.map((h) => h.y));
  const stemY2 = box.stemEnd;
  const flags = box.beamed ? 0 : box.beams;
  const scale = ev.grace ? 0.65 : 1;
  const dotX = Math.max(...heads.map((h) => h.x)) + (HEAD_W / 2 + 0.55) * sp * scale;

  return (
    <g>
      {heads.map((h) => (
        <g
          key={h.noteId}
          id={h.noteId}
          className={`hm-note ${selNotes.has(h.noteId) ? 'hm-selected' : ''} ${flagged.has(h.noteId) ? 'hm-flagged' : ''} ${unverified ? 'hm-unverified' : ''}`}
          onClick={(e) => onNoteClick(e, h.noteId, h.eventId)}
          role="button"
          aria-label="Nốt nhạc"
        >
          {h.ledger.map((l) => (
            <line key={l} x1={h.x - sp * 1.05 * scale} x2={h.x + sp * 1.05 * scale} y1={staffBottom - (l * sp) / 2} y2={staffBottom - (l * sp) / 2} stroke="currentColor" strokeWidth={0.9} />
          ))}
          {h.accidental && <text x={h.accX ?? box.x - sp * 1.05} y={h.y} fontSize={sp * 4 * scale} textAnchor="end" fontFamily="Bravura" fill="currentColor">{SMUFL_ACC[h.accidental] ?? h.accidental}</text>}
          {/* đầu nốt Bravura (SMuFL): đen / trắng / tròn */}
          <text className="hm-head" x={h.x - (ev.duration.type === 'whole' ? 0.84 : HEAD_W / 2) * sp * scale} y={h.y} fontSize={sp * 4 * scale} fontFamily="Bravura" fill="currentColor">
            {ev.duration.type === 'whole' ? '\uE0A2' : filled ? '\uE0A4' : '\uE0A3'}
          </text>
          {ev.duration.dots > 0 && Array.from({ length: ev.duration.dots }, (_, d) => (
            <circle key={d} cx={dotX + d * sp * 0.6} cy={h.staffPos % 2 === 0 ? h.y - sp / 2 : h.y} r={sp * 0.2} fill="currentColor" />
          ))}
          <rect x={h.x - sp} y={h.y - sp * 0.7} width={sp * 2} height={sp * 1.4} fill="transparent" />
        </g>
      ))}
      {hasStem && <line className="hm-stem" x1={stemX} x2={stemX} y1={stemY1} y2={stemY2} stroke="currentColor" strokeWidth={1.1} pointerEvents="none" />}
      {Array.from({ length: flags }, (_, i) => (
        <path key={i} pointerEvents="none" d={box.stemUp
          ? `M${stemX} ${stemY2 + i * sp * 0.8} q${sp * 1.2} ${sp * 0.9} ${sp * 0.8} ${sp * 2.4}`
          : `M${stemX} ${stemY2 - i * sp * 0.8} q${sp * 1.2} ${-sp * 0.9} ${sp * 0.8} ${-sp * 2.4}`} stroke="currentColor" strokeWidth={1.3} fill="none" />
      ))}
      {ev.grace && ev.graceSlash && hasStem && (
        <line x1={stemX - sp * 0.7} x2={stemX + sp * 0.9} y1={stemY2 + (box.stemUp ? sp * 1.6 : -sp * 1.6)} y2={stemY2 + (box.stemUp ? sp * 0.4 : -sp * 0.4)} stroke="currentColor" strokeWidth={0.9} pointerEvents="none" />
      )}
      <Articulations box={box} sp={sp} />
      <Ornaments box={box} sp={sp} />
      {box.lyrics.map((l) => {
        const cx = box.x + l.dx;
        const w = l.text.length * lyric.fontPx * 0.56;
        return (
          <g key={l.verse} className="hm-lyric" pointerEvents="none" fill="currentColor" fontFamily={`'${lyric.family}', 'Noto Serif', Georgia, serif`} fontSize={lyric.fontPx}
            fontStyle={lyric.italicVerses.includes(l.verse) ? 'italic' : undefined}>
            {l.verseLabel && <text x={cx - w / 2 - lyric.fontPx * 0.4} y={l.y} textAnchor="end">{l.verseLabel}</text>}
            <text x={cx} y={l.y} textAnchor="middle">{l.text}</text>
            {l.hyphenX !== undefined && <text x={l.hyphenX} y={l.y} textAnchor="middle">-</text>}
            {l.extendTo !== undefined && <line x1={cx + w / 2 + 2} x2={l.extendTo} y1={l.y + 1} y2={l.y + 1} stroke="currentColor" strokeWidth={0.8} />}
          </g>
        );
      })}
    </g>
  );
}


/** Chùm nốt, dấu nối, dấu luyến, ngoặc liên, cường độ */
function Decorations({ layout }: { layout: ReturnType<typeof layoutScore> }) {
  const { sp } = layout;
  const curve = (c: { x1: number; y1: number; x2: number; y2: number; up: boolean }, thick: number) => {
    const dx = c.x2 - c.x1;
    const h = Math.min(sp * 2.2, Math.max(sp * 0.7, dx * 0.12)) * (c.up ? -1 : 1);
    const mx1 = c.x1 + dx * 0.25;
    const mx2 = c.x1 + dx * 0.75;
    // hình lưỡi liềm: hai đường bezier, dày ở giữa, mảnh ở hai đầu
    return `M${c.x1} ${c.y1} C${mx1} ${c.y1 + h} ${mx2} ${c.y2 + h} ${c.x2} ${c.y2} C${mx2} ${c.y2 + h + thick * (c.up ? 1 : -1)} ${mx1} ${c.y1 + h + thick * (c.up ? 1 : -1)} ${c.x1} ${c.y1} Z`;
  };
  return (
    <g fill="currentColor" pointerEvents="none">
      {layout.beams.map((b) => {
        const t = sp * 0.5;
        const dir = b.stemUp ? 1 : -1;
        const slope = b.x2 === b.x1 ? 0 : (b.y2 - b.y1) / (b.x2 - b.x1);
        const yAt = (x: number) => b.y1 + slope * (x - b.x1);
        return (
          <g key={b.eventIds[0]}>
            <path d={`M${b.x1} ${b.y1} L${b.x2} ${b.y2} L${b.x2} ${b.y2 + t * dir} L${b.x1} ${b.y1 + t * dir} Z`} />
            {b.secondary.map(([a, c, level], i) => {
              const off = (level - 1) * sp * 0.8 * dir;
              return <path key={i} d={`M${a} ${yAt(a) + off} L${c} ${yAt(c) + off} L${c} ${yAt(c) + off + t * dir} L${a} ${yAt(a) + off + t * dir} Z`} />;
            })}
          </g>
        );
      })}
      {layout.ties.map((c) => <path key={c.id} d={curve(c, sp * 0.22)} />)}
      {layout.slurs.map((c) => <path key={c.id} d={curve(c, sp * 0.28)} />)}
      {layout.tuplets.map((t, i) => {
        const mid = (t.x1 + t.x2) / 2;
        const hook = t.up ? sp * 0.6 : -sp * 0.6;
        return (
          <g key={i}>
            {t.bracket && (
              <path d={`M${t.x1} ${t.y + hook} V${t.y} H${mid - sp * 0.9} M${mid + sp * 0.9} ${t.y} H${t.x2} V${t.y + hook}`} stroke="currentColor" strokeWidth={0.8} fill="none" />
            )}
            <text x={mid} y={t.y + sp * 0.45} fontSize={sp * 1.35} fontStyle="italic" fontWeight={700} textAnchor="middle" fontFamily="Georgia, serif">{t.number}</text>
          </g>
        );
      })}
      {layout.dynamics.map((d) => (
        <text key={d.id} x={d.x - sp * 0.4} y={d.y} fontSize={sp * 1.7} fontStyle="italic" fontWeight={700} fontFamily="Georgia, 'Times New Roman', serif">{d.mark}</text>
      ))}
    </g>
  );
}

function Articulations({ box, sp }: { box: EventBox; sp: number }) {
  const ev = box.event;
  if (ev.kind !== 'chord' || !box.heads.length) return null;
  const arts = ev.articulations.filter((a) => a !== 'fermata');
  const below = box.stemUp;
  const edge = below ? Math.max(...box.heads.map((h) => h.y)) : Math.min(...box.heads.map((h) => h.y));
  const dir = below ? 1 : -1;
  const x = box.x;
  return (
    <g fill="currentColor" stroke="currentColor" pointerEvents="none">
      {arts.map((a, i) => {
        const y = edge + dir * sp * (1.3 + i * 1.1);
        switch (a) {
          case 'staccato': return <circle key={a} cx={x} cy={y} r={sp * 0.2} stroke="none" />;
          case 'staccatissimo': return <path key={a} d={`M${x} ${y - sp * 0.4 * dir} L${x - sp * 0.2} ${y + sp * 0.4 * dir} L${x + sp * 0.2} ${y + sp * 0.4 * dir} Z`} stroke="none" />;
          case 'tenuto': return <line key={a} x1={x - sp * 0.6} x2={x + sp * 0.6} y1={y} y2={y} strokeWidth={1.3} />;
          case 'accent': return <path key={a} d={`M${x - sp * 0.7} ${y - sp * 0.4} L${x + sp * 0.7} ${y} L${x - sp * 0.7} ${y + sp * 0.4}`} fill="none" strokeWidth={1.1} />;
          case 'marcato': return <path key={a} d={below ? `M${x - sp * 0.55} ${y - sp * 0.6} L${x} ${y + sp * 0.6} L${x + sp * 0.55} ${y - sp * 0.6}` : `M${x - sp * 0.55} ${y + sp * 0.6} L${x} ${y - sp * 0.6} L${x + sp * 0.55} ${y + sp * 0.6}`} fill="none" strokeWidth={1.4} />;
          default: return null;
        }
      })}
      {ev.articulations.includes('fermata') && (
        <g>
          <path d={`M${x - sp * 1.1} ${box.staffY - sp * 1.2} A${sp * 1.1} ${sp * 1.1} 0 0 1 ${x + sp * 1.1} ${box.staffY - sp * 1.2}`} fill="none" strokeWidth={1.4} />
          <circle cx={x} cy={box.staffY - sp * 1.45} r={sp * 0.22} stroke="none" />
        </g>
      )}
    </g>
  );
}

function Ornaments({ box, sp }: { box: EventBox; sp: number }) {
  const ev = box.event;
  if (ev.kind !== 'chord' || !ev.ornaments?.length) return null;
  const top = Math.min(box.staffY, ...box.heads.map((h) => h.y), box.stemUp ? box.stemEnd : Infinity) - sp * 1.6 - (ev.articulations.includes('fermata') ? sp * 1.8 : 0);
  const x = box.x;
  const w = sp * 0.55;
  return (
    <g pointerEvents="none" fill="none" stroke="currentColor" strokeWidth={1.2}>
      {ev.ornaments.map((o) => {
        switch (o) {
          case 'trill':
            return <text key={o} x={x} y={top} textAnchor="middle" fontSize={sp * 1.7} fontStyle="italic" fontWeight={700} fontFamily="Georgia, serif" fill="currentColor" stroke="none">tr</text>;
          case 'mordent':
          case 'inverted-mordent': {
            const z = `M${x - w * 2} ${top} l${w} ${-w} l${w} ${w * 2} l${w} ${-w * 2} l${w} ${w * 2} l${w} ${-w}`;
            return (
              <g key={o}>
                <path d={z} strokeLinejoin="round" />
                {o === 'mordent' && <line x1={x} x2={x} y1={top - w * 1.8} y2={top + w * 1.8} />}
              </g>
            );
          }
          case 'turn':
          case 'inverted-turn':
            return (
              <g key={o}>
                <path d={`M${x - w * 2.2} ${top} C${x - w * 2.2} ${top - w * 2.2} ${x - w * 0.2} ${top - w * 1.5} ${x} ${top} S${x + w * 2.2} ${top + w * 2.2} ${x + w * 2.2} ${top}`} transform={o === 'inverted-turn' ? `scale(1,-1) translate(0 ${-2 * top})` : undefined} />
                {o === 'inverted-turn' && <line x1={x} x2={x} y1={top - w * 1.8} y2={top + w * 1.8} />}
              </g>
            );
          default:
            return null;
        }
      })}
    </g>
  );
}
