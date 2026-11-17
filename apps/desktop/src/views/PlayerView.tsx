import { useEffect, useMemo, useState } from 'react';
import { useMidiInput } from '../lib/midiInput';
import { HighlightIndex, pitchToMidi, ScoreIndex } from '@holy-melody/music-core';
import { ScoreView } from '../components/ScoreView';
import { SheetView } from '../components/SheetView';
import { ConvertDialog } from '../components/ConvertDialog';
import { useActiveProject, useStore } from '../state/store';
import { playbackPosition, usePlayback } from '../state/playback';

/** Nhạc cụ hay dùng (GM program 0-based) */
const INSTRUMENTS: [number, string][] = [
  [19, 'Organ nhà thờ'], [0, 'Piano'], [16, 'Organ điện'], [52, 'Hợp xướng (Aah)'], [53, 'Giọng hát (Ooh)'],
  [48, 'Dàn dây'], [40, 'Violin'], [42, 'Cello'], [73, 'Sáo'], [71, 'Clarinet'], [24, 'Guitar'], [46, 'Đàn hạc'],
];

export function PlayerLeft() {
  const project = useActiveProject();
  const engine = usePlayback((s) => s.engine);
  useStore((s) => s.revision);
  const [, force] = useState(0);
  const midi = useMidiInput();
  const notify = useStore((s) => s.notify);
  const exec = useStore((s) => s.exec);
  useEffect(() => {
    void midi.refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // áp dụng mixer đã lưu trong dự án khi mở / đổi engine
  useEffect(() => {
    for (const m of project?.score.playback.mixer ?? []) engine.setChannel(m.partId, { volume: m.volume, pan: m.pan, mute: m.mute, solo: m.solo, ...({ reverb: m.reverb, chorus: m.chorus } as object) });
  }, [project?.id, engine]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!project) return null;
  const mixer = project.score.playback.mixer;
  const upd = (partId: string, patch: Partial<(typeof mixer)[number]>) => {
    let m = mixer.find((x) => x.partId === partId);
    if (!m) {
      m = { partId, volume: 0.8, pan: 0, reverb: 0.2, chorus: 0, mute: false, solo: false };
      mixer.push(m);
    }
    Object.assign(m, patch); // thiết lập nghe, lưu cùng dự án (không vào Undo)
    engine.setChannel(partId, { ...patch } as never);
    force((x) => x + 1);
  };
  const slider = (label: string, value: number, min: number, max: number, onChange: (v: number) => void) => (
    <label className="flex items-center gap-2 text-[10.5px] text-muted">
      <span className="w-10">{label}</span>
      <input type="range" min={min} max={max} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-[var(--accent)]" aria-label={label} />
    </label>
  );
  return (
    <div className="p-3 space-y-3">
      <h3 className="text-[11px] uppercase tracking-wide text-muted">Mixer</h3>
      {project.score.parts.map((p) => {
        const c = mixer.find((x) => x.partId === p.id) ?? { volume: 0.8, pan: 0, reverb: 0.2, chorus: 0, mute: false, solo: false };
        return (
          <div key={p.id} className="rounded-md border border-line p-2 space-y-1 bg-surface">
            <div className="flex items-center gap-1.5">
              <span className="flex-1 truncate font-medium">{p.name}</span>
              <button className={`h-6 w-6 text-[11px] rounded ${c.mute ? 'bg-warn text-white' : 'bg-surface-2'}`} onClick={() => upd(p.id, { mute: !c.mute })} title="Tắt tiếng" aria-pressed={c.mute}>M</button>
              <button className={`h-6 w-6 text-[11px] rounded ${c.solo ? 'bg-play text-white' : 'bg-surface-2'}`} onClick={() => upd(p.id, { solo: !c.solo })} title="Solo" aria-pressed={c.solo}>S</button>
            </div>
            {slider('Âm lượng', c.volume, 0, 1, (v) => upd(p.id, { volume: v }))}
            {slider('Pan', c.pan, -1, 1, (v) => upd(p.id, { pan: v }))}
            {slider('Reverb', c.reverb, 0, 1, (v) => upd(p.id, { reverb: v }))}
            <label className="flex items-center gap-2 text-[10.5px] text-muted">
              <span className="w-10">Nhạc cụ</span>
              <select className="flex-1 h-6 rounded border border-line bg-surface px-1 text-[11px] text-fg" value={p.instrument.program}
                onChange={(e) => {
                  const program = Number(e.target.value);
                  const name = INSTRUMENTS.find((x) => x[0] === program)?.[1] ?? `GM #${program + 1}`;
                  exec({ label: 'Đổi nhạc cụ', scope: () => ({ kind: 'all' }), apply: (sc) => { const pp = sc.parts.find((x) => x.id === p.id); if (pp) { pp.instrument.program = program; pp.instrument.name = name; } sc.revision++; } });
                }}>
                {!INSTRUMENTS.some((x) => x[0] === p.instrument.program) && <option value={p.instrument.program}>{p.instrument.name || `GM #${p.instrument.program + 1}`}</option>}
                {INSTRUMENTS.map(([prog, name]) => <option key={prog} value={prog}>{name}</option>)}
              </select>
            </label>
          </div>
        );
      })}
      <h3 className="text-[11px] uppercase tracking-wide text-muted pt-1">Bàn phím MIDI</h3>
      {midi.connected ? (
        <div className="flex items-center gap-2 text-[12px]"><span className="h-2 w-2 rounded-full bg-play" /> <span className="flex-1 truncate">{midi.connected}</span><button className="text-[11px] underline" onClick={() => void midi.disconnect()}>Ngắt</button></div>
      ) : (
        <div className="flex gap-1.5">
          <select className="flex-1 h-8 rounded-md border border-line bg-surface px-1.5 text-[12px]" defaultValue="" onChange={(e) => e.target.value !== '' && void midi.connect(Number(e.target.value)).catch((x) => notify(String(x.message ?? x), 'error'))}>
            <option value="" disabled>{midi.ports.length ? 'Chọn thiết bị…' : 'Không thấy thiết bị'}</option>
            {midi.ports.map((n, i) => <option key={n + i} value={i}>{n}</option>)}
          </select>
          <button className="h-8 px-2 rounded-md border border-line text-[12px]" onClick={() => void midi.refresh()} title="Tìm lại">↻</button>
        </div>
      )}
      <p className="text-[10px] text-muted leading-snug">Engine: {engine.name}.</p>
    </div>
  );
}

export function PlayerRight() {
  const project = useActiveProject();
  const pb = usePlayback();
  const setTab = useStore((s) => s.setTab);
  const selection = useStore((s) => s.selection);
  const [convert, setConvert] = useState(false);
  if (!project) return null;
  const s = project.score;
  const hasSel = !!selection.measureRange || selection.noteIds.length > 0;
  const overlay = s.sheet?.mode === 'overlay';
  return (
    <div className="p-3 space-y-4">
      <button className="w-full h-10 rounded-lg bg-accent text-accent-fg font-semibold shadow-sm hover:brightness-110 active:scale-[0.99] transition" onClick={() => (overlay ? setConvert(true) : setTab('editor'))}>
        {overlay ? 'Chuyển sang Edit · 10 credit' : 'Edit in Score Editor'}
      </button>
      {overlay && <p className="text-[11px] text-muted -mt-2">Đang phát trên bản gốc. Chuyển sang Edit để dựng khuông nhạc và biên tập.</p>}
      {convert && <ConvertDialog onClose={() => setConvert(false)} />}
      <section className="space-y-2">
        <h3 className="text-[11px] uppercase tracking-wide text-muted">Vùng chọn</h3>
        <div className="grid grid-cols-2 gap-1.5">
          <button disabled={!hasSel} className="h-8 rounded-md border border-line hover:bg-surface-2 disabled:opacity-40" onClick={() => pb.playSelection(false)}>Play Selection</button>
          <button disabled={!hasSel} className="h-8 rounded-md border border-line hover:bg-surface-2 disabled:opacity-40" onClick={() => pb.playSelection(true)}>Loop Selection</button>
        </div>
        <p className="text-[11px] text-muted">Kéo chuột trên các ô nhịp để chọn đoạn. Nhấp đúp vào nốt để phát từ nốt đó.</p>
      </section>
      <section className="space-y-2">
        <h3 className="text-[11px] uppercase tracking-wide text-muted">Phát</h3>
        <Row label="Count-in">
          <select className="bg-surface-2 rounded px-1.5 h-7" value={pb.countIn} onChange={(e) => pb.setCountIn(Number(e.target.value))}>
            {[0, 1, 2].map((n) => <option key={n} value={n}>{n === 0 ? 'Không' : `${n} ô`}</option>)}
          </select>
        </Row>
        <Row label="Transpose phát">
          <div className="flex items-center gap-1">
            <button className="h-7 w-7 rounded bg-surface-2" onClick={() => pb.setTranspose(pb.transpose - 1)} aria-label="Hạ nửa cung">−</button>
            <span className="w-8 text-center tabular-nums">{pb.transpose > 0 ? `+${pb.transpose}` : pb.transpose}</span>
            <button className="h-7 w-7 rounded bg-surface-2" onClick={() => pb.setTranspose(pb.transpose + 1)} aria-label="Nâng nửa cung">+</button>
          </div>
        </Row>
      </section>
      <section className="space-y-1 text-[12px]">
        <h3 className="text-[11px] uppercase tracking-wide text-muted">Thông tin</h3>
        <Row label="Nguồn">{s.provenance.source}</Row>
        <Row label="Ô nhịp">{s.measures.length}</Row>
        <Row label="Bè">{s.parts.length}</Row>
        <Row label="Tempo">♩ = {s.tempoMap[0]?.bpm}</Row>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 min-h-7">
      <span className="text-muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** Bàn phím piano ảo: hiển thị nốt đang phát, chơi thử bằng chuột hoặc phím máy tính (A W S E D F T G Y H U J K) */
export function VirtualPiano() {
  const engine = usePlayback((s) => s.engine);
  const tl = useStore((s) => s.timeline);
  const [lit, setLit] = useState<Set<number>>(new Set());
  const [pressed, setPressed] = useState<Set<number>>(new Set());
  const idx = useMemo(() => (tl ? new HighlightIndex(tl.spans) : null), [tl]);
  const project = useActiveProject();
  const sidx = useMemo(() => (project ? new ScoreIndex(project.score) : null), [project, tl]);
  const low = 36;
  const high = 96;

  useEffect(() => {
    let raf = 0;
    let last = '';
    const f = () => {
      if (idx && sidx) {
        const set = new Set<number>();
        for (const s of idx.activeAt(playbackPosition())) {
          const n = sidx.note(s.noteId);
          if (n) set.add(pitchToMidi(n.note.pitch) + n.part.instrument.transposeChromatic);
        }
        const key = [...set].join();
        if (key !== last) {
          last = key;
          setLit(set);
        }
      }
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [idx, sidx]);

  useEffect(() => {
    const map = 'awsedftgyhujk';
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest('input,textarea,select')) return;
      const i = map.indexOf(e.key.toLowerCase());
      if (i < 0 || useStore.getState().tab !== 'player') return;
      engine.previewNote(60 + i);
      setPressed((p) => new Set(p).add(60 + i));
    };
    const up = (e: KeyboardEvent) => {
      const i = map.indexOf(e.key.toLowerCase());
      if (i >= 0) setPressed((p) => { const n = new Set(p); n.delete(60 + i); return n; });
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [engine]);

  const held = useMidiInput((s) => s.held);
  const [mouseKey, setMouseKey] = useState<number | null>(null);
  useEffect(() => {
    const up = () => setMouseKey(null);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', up);
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('blur', up); };
  }, []);
  const press = (m: number) => { setMouseKey(m); engine.previewNote(m); };
  const glide = (m: number) => { if (mouseKey !== null && mouseKey !== m) press(m); };
  const down = (m: number) => pressed.has(m) || held.has(m) || mouseKey === m;
  useEffect(() => useMidiInput.getState().onChord((ps, v) => {
    if (useStore.getState().tab === 'player') for (const p of ps) engine.previewNote(p, v);
  }), [engine]);
  const whites: number[] = [];
  for (let m = low; m <= high; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m);
  const ww = 100 / whites.length;
  return (
    <div className="h-24 shrink-0 border-t border-line bg-surface px-3 py-2" aria-label="Bàn phím piano ảo">
      <div className="relative h-full select-none">
        {whites.map((m, i) => (
          <button
            key={m}
            className={`absolute top-0 bottom-0 border border-line rounded-b-sm transition-colors duration-75 ${down(m) ? 'bg-[var(--hl)] hm-key-down z-[1]' : lit.has(m) ? 'bg-[var(--hl)]' : 'bg-white'}`}
            style={{ left: `${i * ww}%`, width: `${ww}%` }}
            onMouseDown={(e) => { e.preventDefault(); press(m); }}
            onMouseEnter={() => glide(m)}
            aria-label={`Phím ${m}`}
          >
            {m % 12 === 0 && <span className="absolute bottom-0.5 left-0 right-0 text-[8px] text-muted">C{m / 12 - 1}</span>}
          </button>
        ))}
        {Array.from({ length: high - low + 1 }, (_, k) => low + k)
          .filter((m) => [1, 3, 6, 8, 10].includes(m % 12))
          .map((m) => {
            const leftWhite = whites.indexOf(m - 1);
            return (
              <button
                key={m}
                className={`absolute top-0 h-[60%] rounded-b-sm z-10 transition-colors duration-75 ${down(m) ? 'bg-accent hm-key-down' : lit.has(m) ? 'bg-[var(--hl)]' : 'bg-neutral-900'}`}
                style={{ left: `${(leftWhite + 0.68) * ww}%`, width: `${ww * 0.64}%` }}
                onMouseDown={(e) => { e.preventDefault(); press(m); }}
                onMouseEnter={() => glide(m)}
                aria-label={`Phím ${m}`}
              />
            );
          })}
      </div>
    </div>
  );
}

export function PlayerCenter() {
  const project = useActiveProject();
  const sheet = project?.score.sheet;
  const [view, setView] = useState<'sheet' | 'score'>('sheet');
  const showSheet = !!sheet && (sheet.mode === 'overlay' || view === 'sheet');
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {sheet?.mode === 'edit' && (
        <div className="flex gap-1 px-3 py-1 border-b border-line bg-surface text-[11.5px]" role="tablist">
          {([['sheet', 'Bản gốc'], ['score', 'Khuông nhạc đã dựng']] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} className={`h-7 px-3 rounded-md ${view === id ? 'bg-accent-soft font-medium' : 'text-muted hover:bg-surface-2'}`} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      )}
      {showSheet ? <SheetView /> : <ScoreView />}
      <VirtualPiano />
    </div>
  );
}
