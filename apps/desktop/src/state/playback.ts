/**
 * Kết nối engine phát nhạc với store. Vị trí phát luôn lấy từ audio clock của engine.
 */
import { create } from 'zustand';
import { createBestEngine, WebAudioEngine, type PlaybackEngine, type PlaybackStatus } from '@holy-melody/midi-engine';
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

let engine: PlaybackEngine = new WebAudioEngine();
let lastSelKey = '';
/** Phát từ một tick cụ thể (bấm đầu nốt trên bản gốc ảnh/PDF) và ghi nhớ để Play không nhảy lại */
export function markSelectionPlayed(noteIds: string[]) {
  lastSelKey = noteIds.join(',');
}

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
    if (engine.status() === 'playing') {
      get().pause();
      return;
    }
    // vừa chọn nốt mới → phát ngay từ nốt đó; không thì phát tiếp từ vị trí hiện tại
    const st = useStore.getState();
    const ids = st.selection.noteIds;
    const key = ids.join(',');
    if (ids.length && key !== lastSelKey && st.timeline) {
      lastSelKey = key;
      const spans = st.timeline.spans.filter((x) => ids.includes(x.noteId));
      if (spans.length) {
        void get().play(Math.min(...spans.map((x) => x.startTick)));
        return;
      }
    }
    void get().play();
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
  // dịch giọng, nhạc cụ, đệm, dạo đầu, đếm vào đã nằm sẵn trong timeline (store.player)
  engine.load(tl);
}

// Đồng bộ: timeline mới (chỉnh sửa ở bất kỳ tab nào) → nạp lại engine, giữ vị trí
useStore.subscribe((s, prev) => {
  if (s.timeline !== prev.timeline) reload(s.timeline);
});
const onEnded = () => usePlayback.setState({ status: engine.status(), range: null });
engine.onEnded(onEnded);

// Trong app desktop: chuyển sang engine SoundFont (Rust) khi sẵn sàng, giữ nguyên các thiết lập
void createBestEngine().then((best) => {
  if (best === engine || best instanceof WebAudioEngine) return;
  const st = usePlayback.getState();
  engine.dispose();
  engine = best;
  engine.onEnded(onEnded);
  engine.setSpeed(st.speed);
  engine.setMetronome(st.metronome);
  engine.setCountIn(st.countIn);
  engine.setMasterVolume(st.volume);
  usePlayback.setState({ engine });
  reload(useStore.getState().timeline);
});

/** Đọc vị trí theo audio clock (gọi trong requestAnimationFrame) */
export const playbackPosition = () => engine.position();
