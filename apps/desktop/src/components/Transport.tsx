import { useEffect, useRef, useState } from 'react';
import { measureAtTick, tickToSeconds } from '@holy-melody/music-core';
import { useStore } from '../state/store';
import { playbackPosition, usePlayback } from '../state/playback';
import { IconLoop, IconMetronome, IconNext, IconPause, IconPlay, IconPrev, IconRestart, IconStop, IconVolume } from './icons';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Transport({ compact = false, onOpenFull }: { compact?: boolean; onOpenFull?: () => void }) {
  const pb = usePlayback();
  const tl = useStore((s) => s.timeline);
  const hasSel = useStore((s) => !!s.selection.measureRange || s.selection.noteIds.length > 0);
  const [pos, setPos] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const f = () => {
      setPos(playbackPosition());
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, []);

  const total = tl?.totalTicks ?? 0;
  const pm = tl ? measureAtTick(tl, pos) : undefined;
  let bpm = tl?.tempo[0]?.bpm ?? 100;
  for (const t of tl?.tempo ?? []) if (t.tick <= pos) bpm = t.bpm;

  const seekFromEvent = (clientX: number) => {
    const el = barRef.current;
    if (!el || !total) return;
    const r = el.getBoundingClientRect();
    pb.seek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total);
  };

  const btn = 'h-8 w-8 grid place-items-center rounded-md hover:bg-surface-2 active:scale-95 transition disabled:opacity-40';
  const toggle = (on: boolean) => `${btn} ${on ? 'bg-accent-soft text-accent' : ''}`;

  return (
    <div className="flex items-center gap-3 px-3 h-14 border-t border-line bg-surface" role="toolbar" aria-label="Điều khiển phát nhạc">
      <div className="flex items-center gap-0.5">
        <button className={btn} title="Về đầu (Home)" onClick={() => pb.seek(0)} disabled={!tl}><IconRestart /></button>
        <button className={btn} title="Ô trước (,)" onClick={() => pb.stepMeasure(-1)} disabled={!tl}><IconPrev /></button>
        <button
          className="h-10 w-10 grid place-items-center rounded-full bg-accent text-accent-fg shadow-sm hover:brightness-110 active:scale-95 transition disabled:opacity-40"
          title="Phát / Tạm dừng (Space)" onClick={() => pb.toggle()} disabled={!tl || !tl.notes.length}
          aria-label={pb.status === 'playing' ? 'Tạm dừng' : 'Phát'}
        >
          {pb.status === 'playing' ? <IconPause size={18} /> : <IconPlay size={18} />}
        </button>
        <button className={btn} title="Dừng" onClick={() => pb.stop()} disabled={!tl}><IconStop /></button>
        <button className={btn} title="Ô sau (.)" onClick={() => pb.stepMeasure(1)} disabled={!tl}><IconNext /></button>
      </div>

      <div className="flex items-center gap-2 text-[11px] tabular-nums text-muted w-40">
        {pb.status === 'playing' && <span className="hm-eq text-play" aria-hidden><span /><span /><span /></span>}
        <span>{tl ? fmt(tickToSeconds(tl, pos, pb.speed)) : '0:00'} / {tl ? fmt(tickToSeconds(tl, total, pb.speed)) : '0:00'}</span>
        <span className="ml-auto">Ô {pm ? pm.measureIndex + 1 : '–'}</span>
      </div>

      <div
        ref={barRef}
        className="relative flex-1 h-2 rounded-full bg-surface-2 cursor-pointer"
        onMouseDown={(e) => seekFromEvent(e.clientX)}
        role="slider" aria-label="Vị trí phát" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(pos)} tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') pb.stepMeasure(1);
          if (e.key === 'ArrowLeft') pb.stepMeasure(-1);
        }}
      >
        {pb.range && total > 0 && (
          <div className="absolute inset-y-0 bg-info/25 rounded-full" style={{ left: `${(pb.range[0] / total) * 100}%`, width: `${((pb.range[1] - pb.range[0]) / total) * 100}%` }} />
        )}
        <div className="absolute inset-y-0 left-0 bg-accent rounded-full" style={{ width: total ? `${(pos / total) * 100}%` : 0 }} />
      </div>

      {!compact && (
        <button className={`${btn} w-auto px-2 text-xs`} disabled={!hasSel} onClick={() => pb.playSelection(false)} title="Phát vùng chọn">Phát chọn</button>
      )}
      <button className={toggle(pb.loop)} title="Lặp" onClick={() => pb.setLoop(!pb.loop)} aria-pressed={pb.loop}><IconLoop /></button>
      <button className={toggle(pb.metronome)} title="Máy nhịp" onClick={() => pb.setMetronome(!pb.metronome)} aria-pressed={pb.metronome}><IconMetronome /></button>

      <label className="flex items-center gap-1.5 text-xs text-muted" title="Tốc độ phát (không đổi cao độ)">
        <span className="tabular-nums w-16 text-right">♩={Math.round(bpm * pb.speed)}</span>
        <input type="range" min={0.25} max={2} step={0.05} value={pb.speed} onChange={(e) => pb.setSpeed(Number(e.target.value))} className="w-20 accent-[var(--accent)]" aria-label="Tốc độ" />
        <span className="tabular-nums w-9">{Math.round(pb.speed * 100)}%</span>
      </label>
      {!compact && (
        <label className="flex items-center gap-1.5 text-muted" title="Âm lượng">
          <IconVolume />
          <input type="range" min={0} max={1} step={0.01} value={pb.volume} onChange={(e) => pb.setVolume(Number(e.target.value))} className="w-20 accent-[var(--accent)]" aria-label="Âm lượng" />
        </label>
      )}
      {compact && onOpenFull && (
        <button className="h-8 px-3 rounded-md border border-line text-xs hover:bg-surface-2" onClick={onOpenFull}>Mở trong Player</button>
      )}
    </div>
  );
}
