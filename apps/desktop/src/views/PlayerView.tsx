import { useEffect, useMemo, useState } from 'react';
import { useMidiInput } from '../lib/midiInput';
import { HighlightIndex, pitchToMidi, ScoreIndex } from '@holy-melody/music-core';
import { ScoreView } from '../components/ScoreView';
import { SheetView } from '../components/SheetView';
import { CountIn } from '../components/CountIn';
import { ConvertDialog } from '../components/ConvertDialog';
import { useActiveProject, useStore } from '../state/store';
import { playbackPosition, usePlayback } from '../state/playback';
import { useAccount } from '../state/account';

/** Nhạc cụ phát (GM program 0-based); null = theo bản nhạc */
const INSTRUMENTS: [number | null, string][] = [
  [null, 'Theo bản nhạc'], [0, 'Piano'], [19, 'Organ nhà thờ'], [16, 'Organ điện'], [52, 'Hợp xướng (Aah)'], [53, 'Giọng hát (Ooh)'],
  [48, 'Dàn dây'], [40, 'Violin'], [42, 'Cello'], [73, 'Sáo'], [71, 'Clarinet'], [24, 'Guitar'], [46, 'Đàn hạc'],
];

/** Panel trái của Player: chỉ những gì cần khi nghe — nhạc cụ, âm lượng, đệm hợp âm, dịch giọng, tempo */
export function PlayerLeft() {
  const project = useActiveProject();
  const player = useStore((s) => s.player);
  const setPlayer = useStore((s) => s.setPlayer);
  const pb = usePlayback();
  const [convert, setConvert] = useState(false);
  const goEditor = useGoToEditor(() => setConvert(true));
  if (!project) return null;
  const s = project.score;
  const baseBpm = s.tempoMap[0]?.bpm ?? 90;
  const bpm = Math.round(baseBpm * pb.speed);
  const overlay = s.sheet?.mode === 'overlay';
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const label = 'block text-[11px] uppercase tracking-wide text-muted mb-1.5';
  const range = 'w-full accent-[var(--accent)]';

  return (
    <div className="p-3 space-y-5 text-[12.5px]">
      <button className="w-full h-10 rounded-lg bg-accent text-accent-fg font-semibold shadow-sm hover:brightness-110 active:scale-[0.99] transition disabled:opacity-40"
        disabled={!!s.sheet?.pending} onClick={goEditor}>
        Chuyển sang Editor{overlay ? ' · 10 credit' : ''}
      </button>
      {convert && <ConvertDialog onClose={() => setConvert(false)} />}

      <section>
        <label className={label} htmlFor="pl-instr">Nhạc cụ</label>
        <select id="pl-instr" className="w-full h-9 rounded-md border border-line bg-surface px-2" value={player.program ?? ''}
          onChange={(e) => setPlayer({ program: e.target.value === '' ? null : Number(e.target.value) })}>
          {INSTRUMENTS.map(([prog, name]) => <option key={String(prog)} value={prog ?? ''}>{name}</option>)}
        </select>
      </section>

      <section>
        <span className={label}>Âm lượng MIDI <span className="float-right normal-case tabular-nums">{pct(player.melodyVolume)}</span></span>
        <input type="range" min={0} max={1} step={0.01} value={player.melodyVolume} className={range} aria-label="Âm lượng MIDI"
          onChange={(e) => setPlayer({ melodyVolume: Number(e.target.value) })} />
      </section>

      <section>
        <span className={label}>Âm lượng hợp âm <span className="float-right normal-case tabular-nums">{player.chordVolume ? pct(player.chordVolume) : 'Tắt'}</span></span>
        <input type="range" min={0} max={1} step={0.01} value={player.chordVolume} className={range} aria-label="Âm lượng hợp âm"
          onChange={(e) => setPlayer({ chordVolume: Number(e.target.value) })} />
        <div className="flex gap-4 mt-1.5 text-[11.5px] text-muted">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={player.intro} onChange={(e) => setPlayer({ intro: e.target.checked })} /> Dạo đầu</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={player.countIn} onChange={(e) => setPlayer({ countIn: e.target.checked })} /> Đếm vào</label>
        </div>
      </section>

      <section>
        <span className={label}>Transpose phát</span>
        <div className="flex items-center gap-2">
          <button className="h-9 w-9 rounded-md border border-line hover:bg-surface-2 text-[16px]" onClick={() => setPlayer({ transpose: Math.max(-12, player.transpose - 1) })} aria-label="Hạ nửa cung">−</button>
          <span className="flex-1 text-center tabular-nums font-medium">{player.transpose > 0 ? `+${player.transpose}` : player.transpose} <span className="text-muted font-normal">nửa cung</span></span>
          <button className="h-9 w-9 rounded-md border border-line hover:bg-surface-2 text-[16px]" onClick={() => setPlayer({ transpose: Math.min(12, player.transpose + 1) })} aria-label="Nâng nửa cung">+</button>
        </div>
      </section>

      <section>
        <span className={label}>Tempo <span className="float-right normal-case tabular-nums">♩ = {bpm}{pb.speed !== 1 && <button className="ml-2 underline text-muted" onClick={() => pb.setSpeed(1)}>gốc {baseBpm}</button>}</span></span>
        <input type="range" min={0.4} max={2} step={0.01} value={pb.speed} className={range} aria-label="Tempo"
          onChange={(e) => pb.setSpeed(Number(e.target.value))} />
      </section>
    </div>
  );
}

/** "Chuyển sang Editor": cần đăng nhập trước. Bản ảnh/PDF → hộp thoại chuyển (10 credit). */
export function useGoToEditor(openConvert: () => void) {
  const acc = useAccount();
  const project = useActiveProject();
  const st = useStore();
  return () => {
    const go = () => {
      if (project?.score.sheet?.mode === 'overlay') openConvert();
      else st.setTab('editor');
    };
    if (acc.user) return go();
    if (acc.configured === false) {
      st.notify(acc.reason ?? 'Chưa cấu hình tài khoản: không đăng nhập được.', 'error');
      return;
    }
    st.notify('Đăng nhập để chuyển sang Editor…');
    void acc.login().then(() => useAccount.getState().user && go()).catch((e) => st.notify(String((e as Error).message ?? e), 'error'));
  };
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
          if (n) set.add(pitchToMidi(n.note.pitch) + n.part.instrument.transposeChromatic + (useStore.getState().tab === 'player' ? useStore.getState().player.transpose : 0));
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
      <div className="relative flex-1 flex flex-col min-h-0">
        <CountIn />
        {showSheet ? <SheetView /> : <ScoreView />}
      </div>
      <VirtualPiano />
    </div>
  );
}
