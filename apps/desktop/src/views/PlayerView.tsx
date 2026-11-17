import { useEffect, useMemo, useState } from 'react';
import { HighlightIndex, pitchToMidi, ScoreIndex } from '@holy-melody/music-core';
import { ScoreView } from '../components/ScoreView';
import { useActiveProject, useStore } from '../state/store';
import { playbackPosition, usePlayback } from '../state/playback';

export function PlayerLeft() {
  const project = useActiveProject();
  const engine = usePlayback((s) => s.engine);
  const [ch, setCh] = useState<Record<string, { mute: boolean; solo: boolean; volume: number }>>({});
  if (!project) return null;
  const upd = (id: string, patch: Partial<{ mute: boolean; solo: boolean; volume: number }>) => {
    const cur = { mute: false, solo: false, volume: 0.8, ...ch[id], ...patch };
    setCh({ ...ch, [id]: cur });
    engine.setChannel(id, cur);
  };
  return (
    <div className="p-3 space-y-3">
      <h3 className="text-[11px] uppercase tracking-wide text-muted">Bè / Track</h3>
      {project.score.parts.map((p) => {
        const c = { mute: false, solo: false, volume: 0.8, ...ch[p.id] };
        return (
          <div key={p.id} className="rounded-md border border-line p-2 space-y-1.5 bg-surface">
            <div className="flex items-center gap-1.5">
              <span className="flex-1 truncate font-medium">{p.name}</span>
              <button className={`h-6 w-6 text-[11px] rounded ${c.mute ? 'bg-warn text-white' : 'bg-surface-2'}`} onClick={() => upd(p.id, { mute: !c.mute })} title="Tắt tiếng" aria-pressed={c.mute}>M</button>
              <button className={`h-6 w-6 text-[11px] rounded ${c.solo ? 'bg-play text-white' : 'bg-surface-2'}`} onClick={() => upd(p.id, { solo: !c.solo })} title="Solo" aria-pressed={c.solo}>S</button>
            </div>
            <input type="range" min={0} max={1} step={0.01} value={c.volume} onChange={(e) => upd(p.id, { volume: Number(e.target.value) })} className="w-full accent-[var(--accent)]" aria-label={`Âm lượng ${p.name}`} />
            <div className="text-[10px] text-muted">GM #{p.instrument.program + 1} · kênh {p.instrument.channel + 1}</div>
          </div>
        );
      })}
      <p className="text-[10px] text-muted leading-snug">Engine: {engine.name}. Mixer đầy đủ (pan, reverb, chorus, SoundFont) có ở Phase 2 với engine Rust.</p>
    </div>
  );
}

export function PlayerRight() {
  const project = useActiveProject();
  const pb = usePlayback();
  const setTab = useStore((s) => s.setTab);
  const selection = useStore((s) => s.selection);
  if (!project) return null;
  const s = project.score;
  const hasSel = !!selection.measureRange || selection.noteIds.length > 0;
  return (
    <div className="p-3 space-y-4">
      <button className="w-full h-10 rounded-lg bg-accent text-accent-fg font-semibold shadow-sm hover:brightness-110 active:scale-[0.99] transition" onClick={() => setTab('editor')}>
        Edit in Score Editor
      </button>
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

  const whites: number[] = [];
  for (let m = low; m <= high; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m);
  const ww = 100 / whites.length;
  return (
    <div className="h-24 shrink-0 border-t border-line bg-surface px-3 py-2" aria-label="Bàn phím piano ảo">
      <div className="relative h-full select-none">
        {whites.map((m, i) => (
          <button
            key={m}
            className={`absolute top-0 bottom-0 border border-line rounded-b-sm transition-colors ${lit.has(m) ? 'bg-[var(--hl)]' : pressed.has(m) ? 'bg-accent-soft' : 'bg-white'}`}
            style={{ left: `${i * ww}%`, width: `${ww}%` }}
            onMouseDown={() => engine.previewNote(m)}
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
                className={`absolute top-0 h-[60%] rounded-b-sm z-10 ${lit.has(m) ? 'bg-[var(--hl)]' : 'bg-neutral-900'}`}
                style={{ left: `${(leftWhite + 0.68) * ww}%`, width: `${ww * 0.64}%` }}
                onMouseDown={() => engine.previewNote(m)}
                aria-label={`Phím ${m}`}
              />
            );
          })}
      </div>
    </div>
  );
}

export function PlayerCenter() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ScoreView />
      <VirtualPiano />
    </div>
  );
}
