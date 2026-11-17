/**
 * Playback engine — giao diện chung cho:
 *   - TauriEngine (Phase 2): rustysynth + cpal trên audio thread Rust, đọc SoundFont
 *   - WebAudioEngine (đã có): synth cơ bản trong WebView, dùng AudioContext.currentTime làm audio clock
 * UI không bao giờ tự đếm thời gian: vị trí luôn lấy từ engine.position().
 */
import { secondsToTick, tickToSeconds, type MidiNoteEvent, type PlaybackTimeline } from '@holy-melody/music-core';

export type PlaybackStatus = 'stopped' | 'playing' | 'paused';

export interface ChannelState {
  volume: number; // 0..1
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
}

export interface PlaybackEngine {
  readonly name: string;
  load(tl: PlaybackTimeline): void;
  play(fromTick?: number): Promise<void>;
  pause(): void;
  stop(): void;
  seek(tick: number): void;
  /** Vị trí theo audio clock (tick), đã trừ độ trễ đầu ra */
  position(): number;
  status(): PlaybackStatus;
  setSpeed(speed: number): void;
  setLoop(range: [number, number] | null): void;
  setMetronome(on: boolean): void;
  setCountIn(bars: number): void;
  setMasterVolume(v: number): void;
  setChannel(partId: string, state: Partial<ChannelState>): void;
  /** Phát thử một nốt (virtual piano) */
  previewNote(pitch: number, velocity?: number, durationMs?: number): void;
  onEnded(fn: () => void): () => void;
  dispose(): void;
}

export class EngineNotAvailableError extends Error {
  constructor(engine: string, reason: string) {
    super(`${engine} chưa sẵn sàng: ${reason}`);
  }
}

// ====================================================================== WebAudio

const LOOKAHEAD_SEC = 0.12;
const TICK_MS = 25;

/**
 * Synth cơ bản (oscillator + envelope) — chất lượng âm thanh không thay thế SoundFont,
 * nhưng đồng hồ phát là audio clock thật, nên highlight đồng bộ chính xác.
 */
export class WebAudioEngine implements PlaybackEngine {
  readonly name = 'Web Audio (synth cơ bản)';
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private tl: PlaybackTimeline | undefined;
  private st: PlaybackStatus = 'stopped';
  private speed = 1;
  private loop: [number, number] | null = null;
  private metronome = false;
  private countInBars = 0;
  private masterVol = 0.8;
  private channels = new Map<string, ChannelState>();
  /** AudioContext time ứng với tick `anchorTick` */
  private anchorTime = 0;
  private anchorTick = 0;
  private pausedTick = 0;
  private nextIdx = 0;
  private nextBeatTick = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private voices = new Set<{ osc: OscillatorNode; gain: GainNode }>();
  private endedFns = new Set<() => void>();

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new EngineNotAvailableError(this.name, 'WebView không hỗ trợ Web Audio');
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVol;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  load(tl: PlaybackTimeline): void {
    const wasPlaying = this.st === 'playing';
    const pos = this.position();
    this.halt();
    this.tl = tl;
    this.pausedTick = Math.min(pos, tl.totalTicks);
    if (wasPlaying) void this.play(this.pausedTick);
  }

  async play(fromTick?: number): Promise<void> {
    if (!this.tl) return;
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    this.halt();
    let start = fromTick ?? this.pausedTick;
    if (start >= this.tl.totalTicks) start = this.loop?.[0] ?? 0;
    let lead = 0.05;
    if (this.countInBars > 0) lead += this.scheduleCountIn(ctx.currentTime + lead, start);
    this.anchorTime = ctx.currentTime + lead;
    this.anchorTick = start;
    this.nextIdx = this.firstIndexAt(start);
    this.nextBeatTick = this.nextBeatAfter(start);
    this.st = 'playing';
    this.pump();
    this.timer = setInterval(() => this.pump(), TICK_MS);
  }

  pause(): void {
    if (this.st !== 'playing') return;
    this.pausedTick = this.position();
    this.halt();
    this.st = 'paused';
  }

  stop(): void {
    this.halt();
    this.pausedTick = this.loop?.[0] ?? 0;
    this.st = 'stopped';
  }

  seek(tick: number): void {
    const playing = this.st === 'playing';
    this.pausedTick = Math.max(0, tick);
    if (playing) void this.play(this.pausedTick);
  }

  position(): number {
    if (!this.tl) return 0;
    if (this.st !== 'playing' || !this.ctx) return this.pausedTick;
    const latency = (this.ctx.outputLatency ?? 0) + (this.ctx.baseLatency ?? 0);
    const elapsed = this.ctx.currentTime - latency - this.anchorTime;
    if (elapsed < 0) return this.anchorTick;
    const t0 = tickToSeconds(this.tl, this.anchorTick, this.speed);
    return secondsToTick(this.tl, t0 + elapsed, this.speed);
  }

  status(): PlaybackStatus {
    return this.st;
  }

  setSpeed(speed: number): void {
    const pos = this.position();
    this.speed = Math.min(4, Math.max(0.25, speed));
    if (this.st === 'playing') void this.play(pos);
  }
  setLoop(range: [number, number] | null): void {
    this.loop = range;
  }
  setMetronome(on: boolean): void {
    this.metronome = on;
  }
  setCountIn(bars: number): void {
    this.countInBars = Math.max(0, Math.min(4, bars));
  }
  setMasterVolume(v: number): void {
    this.masterVol = v;
    if (this.master) this.master.gain.value = v;
  }
  setChannel(partId: string, state: Partial<ChannelState>): void {
    const cur = this.channels.get(partId) ?? { volume: 0.8, pan: 0, mute: false, solo: false };
    this.channels.set(partId, { ...cur, ...state });
  }

  previewNote(pitch: number, velocity = 90, durationMs = 400): void {
    const ctx = this.ensureCtx();
    void ctx.resume();
    this.voice(ctx.currentTime + 0.01, durationMs / 1000, pitch, velocity, 0, 1);
  }

  onEnded(fn: () => void): () => void {
    this.endedFns.add(fn);
    return () => this.endedFns.delete(fn);
  }

  dispose(): void {
    this.halt();
    void this.ctx?.close();
    this.ctx = undefined;
  }

  // ---------------------------------------------------------------- nội bộ

  private halt() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const now = this.ctx?.currentTime ?? 0;
    for (const v of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, 0.01);
        v.osc.stop(now + 0.05);
      } catch {
        /* đã dừng */
      }
    }
    this.voices.clear();
  }

  private firstIndexAt(tick: number): number {
    const notes = this.tl!.notes;
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid]!.tick < tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private timeOf(tick: number): number {
    const tl = this.tl!;
    return this.anchorTime + tickToSeconds(tl, tick, this.speed) - tickToSeconds(tl, this.anchorTick, this.speed);
  }

  private audible(n: MidiNoteEvent): { gain: number; pan: number } | null {
    const anySolo = [...this.channels.values()].some((c) => c.solo);
    const c = this.channels.get(n.partId) ?? { volume: 0.8, pan: 0, mute: false, solo: false };
    if (c.mute || (anySolo && !c.solo)) return null;
    return { gain: c.volume, pan: c.pan };
  }

  private pump() {
    const ctx = this.ctx;
    const tl = this.tl;
    if (!ctx || !tl || this.st !== 'playing') return;
    const horizon = ctx.currentTime + LOOKAHEAD_SEC;
    const loopEnd = this.loop?.[1] ?? tl.totalTicks;

    while (this.nextIdx < tl.notes.length) {
      const n = tl.notes[this.nextIdx]!;
      if (n.tick >= loopEnd) break;
      const t = this.timeOf(n.tick);
      if (t > horizon) break;
      const a = this.audible(n);
      if (a && t >= ctx.currentTime - 0.01) {
        const dur = this.timeOf(Math.min(n.tick + n.durationTicks, loopEnd)) - t;
        this.voice(t, dur, n.pitch, n.velocity, a.pan, a.gain);
      }
      this.nextIdx++;
    }
    if (this.metronome) {
      while (this.nextBeatTick < loopEnd && this.timeOf(this.nextBeatTick) <= horizon) {
        const m = tl.measures.find((x) => x.startTick === this.nextBeatTick);
        this.click(this.timeOf(this.nextBeatTick), !!m);
        this.nextBeatTick += this.beatTicksAt(this.nextBeatTick);
      }
    }
    if (this.timeOf(loopEnd) <= ctx.currentTime) {
      if (this.loop) {
        void this.play(this.loop[0]);
      } else {
        this.halt();
        this.st = 'stopped';
        this.pausedTick = tl.totalTicks;
        for (const f of this.endedFns) f();
      }
    }
  }

  private beatTicksAt(tick: number): number {
    const tl = this.tl!;
    let ts = tl.timeSigs[0] ?? { tick: 0, beats: 4, beatType: 4 };
    for (const t of tl.timeSigs) if (t.tick <= tick) ts = t;
    return (tl.ticksPerQuarter * 4) / ts.beatType;
  }

  private nextBeatAfter(tick: number): number {
    const tl = this.tl!;
    const m = tl.measures.find((x) => x.startTick <= tick && tick < x.endTick);
    if (!m) return tick;
    const beat = this.beatTicksAt(tick);
    return m.startTick + Math.ceil((tick - m.startTick) / beat) * beat;
  }

  private scheduleCountIn(at: number, tick: number): number {
    const tl = this.tl!;
    let ts = tl.timeSigs[0] ?? { tick: 0, beats: 4, beatType: 4 };
    for (const t of tl.timeSigs) if (t.tick <= tick) ts = t;
    let bpm = tl.tempo[0]?.bpm ?? 100;
    for (const t of tl.tempo) if (t.tick <= tick) bpm = t.bpm;
    const beatSec = (60 / bpm) * (4 / ts.beatType) / this.speed;
    const beats = ts.beats * this.countInBars;
    for (let i = 0; i < beats; i++) this.click(at + i * beatSec, i % ts.beats === 0);
    return beats * beatSec;
  }

  private click(at: number, accent: boolean) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.35, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(g).connect(this.master!);
    osc.start(at);
    osc.stop(at + 0.06);
  }

  private voice(at: number, dur: number, pitch: number, velocity: number, pan: number, gainMul: number) {
    const ctx = this.ctx!;
    const freq = 440 * 2 ** ((pitch - 69) / 12);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    const peak = (velocity / 127) * 0.22 * gainMul;
    const end = at + Math.max(0.05, dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.012);
    g.gain.setTargetAtTime(peak * 0.6, at + 0.012, 0.15);
    g.gain.setTargetAtTime(0.0001, end, 0.04);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    osc.connect(g).connect(p).connect(this.master!);
    osc.start(at);
    osc.stop(end + 0.3);
    const v = { osc, gain: g };
    this.voices.add(v);
    osc.onended = () => this.voices.delete(v);
  }
}

// ====================================================================== Tauri (Phase 2)

/**
 * Engine native qua Tauri IPC. Lệnh Rust `playback_*` thuộc Phase 2; hiện ném lỗi rõ ràng
 * để UI tự chuyển sang WebAudioEngine thay vì giả lập thành công.
 */
export async function createBestEngine(): Promise<PlaybackEngine> {
  const tauri = (globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  if (tauri) {
    try {
      const ok = await tauri.invoke('playback_engine_available');
      if (ok === true) {
        // Phase 2: return new TauriEngine(tauri.invoke)
      }
    } catch {
      /* lệnh chưa có → dùng WebAudio */
    }
  }
  return new WebAudioEngine();
}
