/**
 * Phần mở đầu khi phát trong Player: "Dạo đầu" rồi đếm vào kiểu karaoke (các chấm sáng dần + số phách to),
 * đồng bộ theo audio clock. Kèm tên hợp âm đang đệm.
 */
import { useEffect, useState } from 'react';
import type { AccompaniedTimeline } from '@holy-melody/music-core';
import { useStore } from '../state/store';
import { playbackPosition, usePlayback } from '../state/playback';

/**
 * Đặt ngay phía trên dòng nhạc đầu tiên: `left`/`top` là toạ độ (px) đầu dòng nhạc đầu tiên trong khung trang.
 * Không truyền toạ độ → chỉ hiện tên hợp âm đang đệm ở góc (dùng ở khung Player).
 */
export function CountIn({ left, top }: { left?: number; top?: number }) {
  const anchored = left !== undefined && top !== undefined;
  const tl = useStore((s) => s.timeline) as AccompaniedTimeline | null;
  const [state, setState] = useState<{ phase: 'intro' | 'count' | 'song' | 'idle'; beat: number; chord: string }>({ phase: 'idle', beat: 0, chord: '' });

  useEffect(() => {
    if (!tl?.preroll) return;
    let raf = 0;
    let last = '';
    const { introTicks, countInTicks, beatTicks } = tl.preroll;
    const f = () => {
      const tick = playbackPosition();
      const playing = usePlayback.getState().status === 'playing';
      const phase = !playing && tick === 0 ? 'idle' : tick < introTicks ? 'intro' : tick < introTicks + countInTicks ? 'count' : 'song';
      const beat = phase === 'count' ? Math.floor((tick - introTicks) / beatTicks) + 1 : 0;
      const chord = playing ? tl.chordTrack.find((c) => c.tick <= tick && tick < c.endTick)?.name ?? '' : '';
      const key = `${phase}|${beat}|${chord}`;
      if (key !== last) {
        last = key;
        setState({ phase, beat, chord });
      }
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [tl]);

  if (!tl?.preroll) return null;
  const { beats } = tl.preroll;
  if (!anchored) {
    return state.phase === 'song' && state.chord ? (
      <div className="pointer-events-none absolute right-6 top-3 z-20 px-3 py-1 rounded-lg bg-surface/90 border border-line text-[15px] font-semibold" title="Hợp âm đang đệm">{state.chord}</div>
    ) : null;
  }
  return (
    <div className="pointer-events-none absolute z-20" style={{ left, top, transform: 'translateY(-100%)' }}>
      {state.phase === 'intro' && (
        <div className="px-3 py-1 rounded-full bg-surface border border-accent/40 shadow text-[13px] font-medium text-accent hm-enter whitespace-nowrap">♪ Dạo đầu…</div>
      )}
      {state.phase === 'count' && (
        <div className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-xl bg-surface border border-accent/40 shadow-md hm-enter" role="status" aria-live="assertive">
          {Array.from({ length: beats }, (_, i) => (
            <span key={i} className={`h-3.5 w-3.5 rounded-full transition-all duration-100 ${i < state.beat ? 'bg-accent scale-110' : 'bg-line'}`} />
          ))}
          <span className="ml-1 text-[26px] leading-none font-bold tabular-nums text-accent w-6 text-center">{state.beat}</span>
        </div>
      )}
    </div>
  );
}
