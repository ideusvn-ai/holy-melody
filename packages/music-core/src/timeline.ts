/**
 * Score → Playback timeline.
 * Mỗi sự kiện MIDI mang noteIds để renderer highlight đúng nốt theo audio clock.
 * Audio engine (Rust) chỉ cần `notes` + `tempo`; UI dùng `spans` + `measures`.
 */
import { TICKS_PER_QUARTER, type DynamicMark, type ScoreDocument } from './model.js';
import { pitchToMidi } from './pitch.js';
import { eventTicksIn, keyAt, measureTicks, timeSigAt } from './score.js';

export interface PlayedMeasure {
  measureIndex: number;
  measureId: string;
  /** Lần thứ mấy ô này được phát (với repeat) */
  pass: number;
  startTick: number;
  endTick: number;
}

export interface MidiNoteEvent {
  tick: number;
  durationTicks: number;
  channel: number;
  program: number;
  partId: string;
  /** Cao độ thực (sounding) sau khi áp dụng transpose nhạc cụ và transpose playback */
  pitch: number;
  velocity: number;
  /** Các note id được gộp bởi dấu nối */
  noteIds: string[];
}

export interface HighlightSpan {
  noteId: string;
  eventId: string;
  partId: string;
  measureId: string;
  startTick: number;
  endTick: number;
}

export interface TempoPoint {
  tick: number;
  bpm: number;
}

export interface PlaybackTimeline {
  ticksPerQuarter: number;
  measures: PlayedMeasure[];
  notes: MidiNoteEvent[];
  spans: HighlightSpan[];
  tempo: TempoPoint[];
  timeSigs: { tick: number; beats: number; beatType: number }[];
  keySigs: { tick: number; fifths: number; mode: 'major' | 'minor' }[];
  parts: { partId: string; channel: number; program: number; name: string }[];
  totalTicks: number;
}

export interface TimelineOptions {
  unrollRepeats?: boolean;
  /** Chỉ phát các part này (mặc định: tất cả) */
  partIds?: string[];
  /** Phát đoạn chọn theo chỉ số ô nhịp [from, to] (bao gồm), không unroll */
  measureRange?: [number, number];
  transposeSemitones?: number;
}

const VELOCITY: Record<DynamicMark, number> = { ppp: 24, pp: 36, p: 50, mp: 64, mf: 78, f: 92, ff: 106, fff: 120, sf: 110, sfz: 112, fp: 92 };
const DEFAULT_VELOCITY = 78;

/** Thứ tự phát các ô nhịp sau khi xử lý repeat và volta. */
export function playOrder(score: ScoreDocument): { index: number; pass: number }[] {
  const ms = score.measures;
  const order: { index: number; pass: number }[] = [];
  let i = 0;
  let start = 0;
  let pass = 1;
  let returning = false;
  let guard = 0;
  while (i < ms.length && guard++ < ms.length * 20) {
    const m = ms[i]!;
    if (m.repeatStart && !returning) {
      start = i;
      pass = 1;
    }
    returning = false;
    if (!m.volta && i > 0 && ms[i - 1]!.volta && pass > 1) {
      // đã hết nhóm volta
      pass = 1;
      start = i;
    }
    if (m.volta && !m.volta.numbers.includes(pass)) {
      i++;
      continue;
    }
    order.push({ index: i, pass });
    if (m.repeatEnd) {
      const times = m.repeatTimes ?? 2;
      if (pass < times) {
        pass++;
        i = start;
        returning = true;
        continue;
      }
      pass = 1;
      start = i + 1;
    }
    i++;
  }
  return order;
}

export function buildTimeline(score: ScoreDocument, opts: TimelineOptions = {}): PlaybackTimeline {
  const transpose = opts.transposeSemitones ?? score.playback.transposeSemitones ?? 0;
  const parts = score.parts.filter((p) => !opts.partIds || opts.partIds.includes(p.id));
  let order: { index: number; pass: number }[];
  if (opts.measureRange) {
    const [a, b] = opts.measureRange;
    order = [];
    for (let k = Math.max(0, a); k <= Math.min(b, score.measures.length - 1); k++) order.push({ index: k, pass: 1 });
  } else if (opts.unrollRepeats === false) {
    order = score.measures.map((_, index) => ({ index, pass: 1 }));
  } else {
    order = playOrder(score);
  }

  const tl: PlaybackTimeline = {
    ticksPerQuarter: TICKS_PER_QUARTER,
    measures: [],
    notes: [],
    spans: [],
    tempo: [],
    timeSigs: [],
    keySigs: [],
    parts: parts.map((p) => ({ partId: p.id, channel: p.instrument.channel, program: p.instrument.program, name: p.name })),
    totalTicks: 0,
  };

  // Tempo hiện hành tại ô bắt đầu (nếu phát từ giữa bài)
  const firstIdx = order[0]?.index ?? 0;
  let curBpm = 100;
  for (const t of score.tempoMap) if (t.measureIndex < firstIdx || (t.measureIndex === firstIdx && t.offset === 0)) curBpm = t.bpm;
  tl.tempo.push({ tick: 0, bpm: curBpm });

  // Dynamics đã sắp xếp theo vị trí viết
  const measurePos = new Map(score.measures.map((m, i) => [m.id, i]));
  const dynByPart = new Map<string, { mi: number; offset: number; vel: number }[]>();
  for (const d of score.dynamics) {
    const list = dynByPart.get(d.partId) ?? [];
    list.push({ mi: measurePos.get(d.measureId) ?? 0, offset: d.offset, vel: VELOCITY[d.mark] });
    dynByPart.set(d.partId, list);
  }
  for (const l of dynByPart.values()) l.sort((a, b) => a.mi - b.mi || a.offset - b.offset);
  const velocityAt = (partId: string, mi: number, offset: number) => {
    let v = DEFAULT_VELOCITY;
    for (const d of dynByPart.get(partId) ?? []) {
      if (d.mi < mi || (d.mi === mi && d.offset <= offset)) v = d.vel;
      else break;
    }
    return v;
  };

  // Dấu nối: key = partId:voiceNumber:pitch → sự kiện đang mở
  const openTies = new Map<string, MidiNoteEvent>();
  let tick = 0;
  let lastTs = '';
  let lastKey = '';

  for (const { index: mi, pass } of order) {
    const m = score.measures[mi]!;
    const len = measureTicks(score, mi);
    tl.measures.push({ measureIndex: mi, measureId: m.id, pass, startTick: tick, endTick: tick + len });

    const ts = timeSigAt(score, mi);
    const tsKey = `${ts.beats}/${ts.beatType}`;
    if (tsKey !== lastTs) {
      tl.timeSigs.push({ tick, beats: ts.beats, beatType: ts.beatType });
      lastTs = tsKey;
    }
    const ks = keyAt(score, mi);
    const ksKey = `${ks.fifths}${ks.mode}`;
    if (ksKey !== lastKey) {
      tl.keySigs.push({ tick, fifths: ks.fifths, mode: ks.mode });
      lastKey = ksKey;
    }
    for (const t of score.tempoMap) {
      if (t.measureIndex !== mi) continue;
      const at = tick + t.offset;
      const last = tl.tempo[tl.tempo.length - 1]!;
      if (last.tick === at) last.bpm = t.bpm;
      else if (last.bpm !== t.bpm) tl.tempo.push({ tick: at, bpm: t.bpm });
    }

    for (const part of parts) {
      for (const voice of part.content[m.id] ?? []) {
        const timings = eventTicksIn(score, mi, voice.events);
        voice.events.forEach((ev, ei) => {
          const { start, ticks } = timings[ei]!;
          if (ev.kind !== 'chord' || ev.grace) return;
          const at = tick + start;
          for (const n of ev.notes) {
            const sounding = pitchToMidi(n.pitch) + part.instrument.transposeChromatic + transpose;
            tl.spans.push({ noteId: n.id, eventId: ev.id, partId: part.id, measureId: m.id, startTick: at, endTick: at + ticks });
            const key = `${part.id}:${voice.number}:${sounding}`;
            const open = openTies.get(key);
            if (n.tieStop && open && open.tick + open.durationTicks === at) {
              open.durationTicks += ticks;
              open.noteIds.push(n.id);
              if (!n.tieStart) openTies.delete(key);
              continue;
            }
            if (sounding < 0 || sounding > 127) continue;
            const me: MidiNoteEvent = {
              tick: at,
              durationTicks: ticks,
              channel: part.instrument.channel,
              program: part.instrument.program,
              partId: part.id,
              pitch: sounding,
              velocity: Math.min(127, velocityAt(part.id, mi, start) + (ev.articulations.includes('accent') ? 12 : 0)),
              noteIds: [n.id],
            };
            if (ev.articulations.includes('staccato')) me.durationTicks = Math.max(1, Math.round(ticks / 2));
            tl.notes.push(me);
            if (n.tieStart) openTies.set(key, me);
          }
        });
      }
    }
    tick += len;
  }
  tl.totalTicks = tick;
  tl.notes.sort((a, b) => a.tick - b.tick || a.channel - b.channel || a.pitch - b.pitch);
  tl.spans.sort((a, b) => a.startTick - b.startTick);
  return tl;
}

// ---------------------------------------------------------------- thời gian thực

/** tick → giây theo tempo map (speed = hệ số tốc độ phát, không đổi cao độ) */
export function tickToSeconds(tl: PlaybackTimeline, tick: number, speed = 1): number {
  let sec = 0;
  for (let i = 0; i < tl.tempo.length; i++) {
    const cur = tl.tempo[i]!;
    const nextTick = tl.tempo[i + 1]?.tick ?? Infinity;
    if (tick <= cur.tick) break;
    const span = Math.min(tick, nextTick) - cur.tick;
    sec += (span / tl.ticksPerQuarter) * (60 / cur.bpm);
  }
  return sec / speed;
}

export function secondsToTick(tl: PlaybackTimeline, seconds: number, speed = 1): number {
  let remaining = seconds * speed;
  for (let i = 0; i < tl.tempo.length; i++) {
    const cur = tl.tempo[i]!;
    const nextTick = tl.tempo[i + 1]?.tick ?? Infinity;
    const secPerTick = 60 / cur.bpm / tl.ticksPerQuarter;
    const spanSec = (nextTick - cur.tick) * secPerTick;
    if (remaining <= spanSec) return cur.tick + remaining / secPerTick;
    remaining -= spanSec;
  }
  return tl.totalTicks;
}

/** Tra nhanh các nốt đang kêu tại một tick (dùng cho highlight). */
export class HighlightIndex {
  private maxLen = 0;
  constructor(private readonly spans: HighlightSpan[]) {
    for (const s of spans) this.maxLen = Math.max(this.maxLen, s.endTick - s.startTick);
  }

  activeAt(tick: number): HighlightSpan[] {
    // spans đã sắp xếp theo startTick: tìm vị trí cuối cùng có startTick <= tick
    let lo = 0;
    let hi = this.spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.spans[mid]!.startTick <= tick) lo = mid + 1;
      else hi = mid;
    }
    const out: HighlightSpan[] = [];
    for (let i = lo - 1; i >= 0; i--) {
      const s = this.spans[i]!;
      if (s.startTick < tick - this.maxLen) break;
      if (s.startTick <= tick && tick < s.endTick) out.push(s);
    }
    return out.reverse();
  }

  firstTickOf(noteId: string): number | undefined {
    return this.spans.find((s) => s.noteId === noteId)?.startTick;
  }
}

export function measureAtTick(tl: PlaybackTimeline, tick: number): PlayedMeasure | undefined {
  return tl.measures.find((m) => m.startTick <= tick && tick < m.endTick);
}
