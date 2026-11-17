/**
 * Bàn phím MIDI ngoài: kết nối qua Rust (midir), nhận sự kiện `midi://in`.
 * - Player: chơi thử, sáng phím trên piano ảo
 * - Score Editor: nhập nốt step-time; các phím nhấn trong vòng 60 ms gộp thành hợp âm
 */
import { create } from 'zustand';
import { tauriInvoke } from './fileio';

type Listen = (event: string, cb: (e: { payload: { status: number; data1: number; data2: number } }) => void) => Promise<() => void>;

interface MidiInputState {
  ports: string[];
  connected: string | null;
  held: Set<number>;
  refresh(): Promise<void>;
  connect(index: number): Promise<void>;
  disconnect(): Promise<void>;
  /** đăng ký nhận các nhóm nốt (hợp âm) vừa nhấn */
  onChord(fn: (pitches: number[], velocity: number) => void): () => void;
}

const chordFns = new Set<(p: number[], v: number) => void>();
let unlisten: (() => void) | undefined;
let pending: number[] = [];
let pendingVel = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export const useMidiInput = create<MidiInputState>((set, get) => ({
  ports: [],
  connected: null,
  held: new Set(),
  async refresh() {
    const invoke = tauriInvoke();
    if (!invoke) return;
    set({ ports: ((await invoke('midi_list').catch(() => [])) as string[]) ?? [] });
  },
  async connect(index) {
    const invoke = tauriInvoke();
    if (!invoke) throw new Error('Bàn phím MIDI cần ứng dụng desktop');
    const name = (await invoke('midi_connect', { index })) as string;
    if (!unlisten) {
      const { listen } = (await import('@tauri-apps/api/event')) as unknown as { listen: Listen };
      unlisten = await listen('midi://in', ({ payload }) => {
        const kind = payload.status & 0xf0;
        const held = new Set(get().held);
        if (kind === 0x90 && payload.data2 > 0) {
          held.add(payload.data1);
          pending.push(payload.data1);
          pendingVel = Math.max(pendingVel, payload.data2);
          clearTimeout(timer);
          timer = setTimeout(() => {
            const notes = [...new Set(pending)].sort((a, b) => a - b);
            pending = [];
            for (const f of chordFns) f(notes, pendingVel);
            pendingVel = 0;
          }, 60);
        } else if (kind === 0x80 || (kind === 0x90 && payload.data2 === 0)) {
          held.delete(payload.data1);
        }
        set({ held });
      });
    }
    set({ connected: name });
  },
  async disconnect() {
    await tauriInvoke()?.('midi_disconnect');
    set({ connected: null, held: new Set() });
  },
  onChord(fn) {
    chordFns.add(fn);
    return () => chordFns.delete(fn);
  },
}));
