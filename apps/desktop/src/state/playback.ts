/**
 * Kết nối engine phát nhạc với store. Vị trí phát luôn lấy từ audio clock của engine.
 */
import { create } from 'zustand';
import { WebAudioEngine, type PlaybackEngine, type PlaybackStatus } from '@holy-melody/midi-engine';
import { measureAtTick, type PlaybackTimeline } from '@holy-melody/music-core';
import { useStore } from './store';

interface PlaybackState {
  engine: PlaybackEngine;
  status: PlaybackStatus;
  speed: number;
  bpmOverride: number | null;
  loop: boolean;
  metronome: boolean;
  countIn: number;
  volume: number;
  transpose: number;
  /** Phạm vi đang phát (tick) khi phát vùng chọn */
  range: [number, number] | null;

  play(fromTick?: number): Promise<void>;
  pause(): void;
  stop(): void;
  toggle(): void;
  seek(tick: number): void;
  stepMeasure(delta: number): void;
  setSpeed(v: number): void;
  setLoop(v: boolean): void;
  setMetronome(v: boolean): void;
  setCountIn(v: number): void;
  setVolume(v: number): void;
  setTranspose(v: number): void;
  playSelection(loop?: boolean): void;
}

const engine: PlaybackEngine = new WebAudioEngine();

export const usePlayback = create<PlaybackState>((set, get) => ({
  engine,
  status: 'stopped',
  speed: 1,
  bpmOverride: null,
  loop: false,
  metronome: false,
  countIn: 0,
  volume: 0.8,
  transpose: 0,
  range: null,

  async play(fromTick) {
    try {
      await engine.play(fromTick);
      set({ status: engine.status() });
    } catch (e) {
      useStore.getState().notify((e as Error).message, 'error');
    }
  },
  pause() {
    engine.pause();
    set({ status: engine.status() });
  },
  stop() {
    engine.stop();
    set({ status: engine.status() });
  },
  toggle() {
    if (engine.status() === 'playing') get().pause();
    else void get().play();
  },
  seek(tick) {
    engine.seek(tick);
  },
  stepMeasure(delta) {
    const tl = useStore.getState().timeline;
    if (!tl) return;
    const cur = measureAtTick(tl, engine.position());
    const idx = cur ? tl.measures.indexOf(cur) : 0;
    const next = tl.measures[Math.max(0, Math.min(tl.measures.length - 1, idx + delta))];
    if (next) engine.seek(next.startTick);
  },
  setSpeed(v) {
    engine.setSpeed(v);
    set({ speed: v });
  },
  setLoop(v) {
    set({ loop: v });
    applyLoop();
  },
  setMetronome(v) {
    engine.setMetronome(v);
    set({ metronome: v });
  },
  setCountIn(v) {
    engine.setCountIn(v);
    set({ countIn: v });
  },
  setVolume(v) {
    engine.setMasterVolume(v);
    set({ volume: v });
  },
  setTranspose(v) {
    set({ transpose: v });
    reload(useStore.getState().timeline);
  },
  playSelection(loop = false) {
    const st = useStore.getState();
    const tl = st.timeline;
    if (!tl) return;
    const sel = st.selection.measureRange;
    let range: [number, number] | null = null;
    if (sel) {
      const ms = tl.measures.filter((m) => m.measureIndex >= sel[0] && m.measureIndex <= sel[1] && m.pass === 1);
      if (ms.length) range = [ms[0]!.startTick, ms[ms.length - 1]!.endTick];
    } else if (st.selection.noteIds.length) {
      const spans = tl.spans.filter((s) => st.selection.noteIds.includes(s.noteId));
      if (spans.length) range = [Math.min(...spans.map((s) => s.startTick)), Math.max(...spans.map((s) => s.endTick))];
    }
    if (!range) {
      st.notify('Hãy chọn ô nhịp hoặc nốt trước khi phát vùng chọn.');
      return;
    }
    set({ range, loop });
    applyLoop();
    void get().play(range[0]);
  },
}));

function applyLoop() {
  const { loop, range } = usePlayback.getState();
  const tl = useStore.getState().timeline;
  engine.setLoop(range ? (loop ? range : [range[0], range[1]]) : loop && tl ? [0, tl.totalTicks] : null);
}

function reload(tl: PlaybackTimeline | null) {
  if (!tl) return;
  const t = usePlayback.getState().transpose;
  engine.load(t ? { ...tl, notes: tl.notes.map((n) => ({ ...n, pitch: Math.max(0, Math.min(127, n.pitch + t)) })) } : tl);
}

// Đồng bộ: timeline mới (chỉnh sửa ở bất kỳ tab nào) → nạp lại engine, giữ vị trí
useStore.subscribe((s, prev) => {
  if (s.timeline !== prev.timeline) reload(s.timeline);
});
engine.onEnded(() => usePlayback.setState({ status: engine.status(), range: null }));

/** Đọc vị trí theo audio clock (gọi trong requestAnimationFrame) */
export const playbackPosition = () => engine.position();
