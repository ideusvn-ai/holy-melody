/**
 * Standard MIDI File (SMF) đọc/ghi + chuyển đổi Score ⇄ MIDI.
 */
import { ticksToDurations } from './duration.js';
import { newId } from './ids.js';
import { TICKS_PER_QUARTER, type ChordEvent, type Duration, type MusicEvent, type Part, type ScoreDocument, type Voice } from './model.js';
import { spellMidi } from './pitch.js';
import { chord, createMeasure, createScore, nominalMeasureTicks, rest } from './score.js';
import { buildTimeline, type PlaybackTimeline, type TimelineOptions } from './timeline.js';

// ====================================================================== SMF low-level

export type MidiEvent =
  | { tick: number; kind: 'noteOn'; channel: number; pitch: number; velocity: number }
  | { tick: number; kind: 'noteOff'; channel: number; pitch: number; velocity: number }
  | { tick: number; kind: 'programChange'; channel: number; program: number }
  | { tick: number; kind: 'controlChange'; channel: number; controller: number; value: number }
  | { tick: number; kind: 'pitchBend'; channel: number; value: number }
  | { tick: number; kind: 'tempo'; microsecondsPerQuarter: number }
  | { tick: number; kind: 'timeSignature'; numerator: number; denominator: number }
  | { tick: number; kind: 'keySignature'; fifths: number; minor: boolean }
  | { tick: number; kind: 'trackName'; text: string }
  | { tick: number; kind: 'text'; text: string }
  | { tick: number; kind: 'lyric'; text: string }
  | { tick: number; kind: 'endOfTrack' }
  | { tick: number; kind: 'other' };

export interface MidiTrack {
  events: MidiEvent[];
}
export interface MidiFile {
  format: 0 | 1 | 2;
  division: number;
  tracks: MidiTrack[];
}

export class MidiParseError extends Error {}

function writeVlq(out: number[], v: number) {
  const bytes = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(...bytes);
}

const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u16 = (v: number) => [(v >>> 8) & 0xff, v & 0xff];
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

/** Thứ tự ưu tiên cùng tick: meta trước, noteOff trước noteOn */
const ORDER: Record<MidiEvent['kind'], number> = {
  trackName: 0, text: 1, tempo: 1, timeSignature: 1, keySignature: 1, programChange: 2, controlChange: 3,
  pitchBend: 3, noteOff: 4, lyric: 5, noteOn: 6, other: 7, endOfTrack: 9,
};

export function writeMidiFile(file: MidiFile): Uint8Array {
  const out: number[] = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(file.format), ...u16(file.tracks.length), ...u16(file.division)];
  for (const track of file.tracks) {
    const evs: MidiEvent[] = track.events.filter((e) => e.kind !== 'endOfTrack' && e.kind !== 'other');
    evs.sort((a, b) => a.tick - b.tick || ORDER[a.kind] - ORDER[b.kind]);
    const last = evs.length ? evs[evs.length - 1]!.tick : 0;
    evs.push({ tick: last, kind: 'endOfTrack' });
    const data: number[] = [];
    let prev = 0;
    for (const e of evs) {
      writeVlq(data, e.tick - prev);
      prev = e.tick;
      switch (e.kind) {
        case 'noteOn': data.push(0x90 | e.channel, e.pitch, e.velocity); break;
        case 'noteOff': data.push(0x80 | e.channel, e.pitch, e.velocity); break;
        case 'programChange': data.push(0xc0 | e.channel, e.program); break;
        case 'controlChange': data.push(0xb0 | e.channel, e.controller, e.value); break;
        case 'pitchBend': data.push(0xe0 | e.channel, e.value & 0x7f, (e.value >> 7) & 0x7f); break;
        case 'tempo': {
          const t = e.microsecondsPerQuarter;
          data.push(0xff, 0x51, 0x03, (t >> 16) & 0xff, (t >> 8) & 0xff, t & 0xff);
          break;
        }
        case 'timeSignature':
          data.push(0xff, 0x58, 0x04, e.numerator, Math.log2(e.denominator), 24, 8);
          break;
        case 'keySignature':
          data.push(0xff, 0x59, 0x02, e.fifths & 0xff, e.minor ? 1 : 0);
          break;
        case 'trackName':
        case 'text':
        case 'lyric': {
          const b = utf8(e.text);
          data.push(0xff, e.kind === 'trackName' ? 0x03 : e.kind === 'lyric' ? 0x05 : 0x01);
          writeVlq(data, b.length);
          data.push(...b);
          break;
        }
        case 'endOfTrack': data.push(0xff, 0x2f, 0x00); break;
      }
    }
    out.push(0x4d, 0x54, 0x72, 0x6b, ...u32(data.length), ...data);
  }
  return new Uint8Array(out);
}

export function parseMidiFile(bytes: Uint8Array): MidiFile {
  let p = 0;
  const need = (n: number) => {
    if (p + n > bytes.length) throw new MidiParseError('File MIDI bị cắt cụt');
  };
  const rd32 = () => { need(4); const v = (bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!; p += 4; return v >>> 0; };
  const rd16 = () => { need(2); const v = (bytes[p]! << 8) | bytes[p + 1]!; p += 2; return v; };
  const tag = () => { need(4); const s = String.fromCharCode(...bytes.subarray(p, p + 4)); p += 4; return s; };
  const vlq = (end: number) => {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      if (p >= end) throw new MidiParseError('VLQ lỗi');
      const b = bytes[p++]!;
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new MidiParseError('VLQ quá dài');
  };

  // RIFF wrapper (.rmi)
  if (tag() === 'RIFF') {
    p = 0;
    const idx = findSeq(bytes, [0x4d, 0x54, 0x68, 0x64]);
    if (idx < 0) throw new MidiParseError('Không tìm thấy MThd');
    p = idx + 4;
  } else {
    p = 0;
    if (tag() !== 'MThd') throw new MidiParseError('Không phải file MIDI (thiếu MThd)');
  }
  const hlen = rd32();
  const format = rd16() as 0 | 1 | 2;
  const ntracks = rd16();
  const division = rd16();
  if (division & 0x8000) throw new MidiParseError('MIDI dùng SMPTE timecode chưa được hỗ trợ');
  p += hlen - 6;

  const tracks: MidiTrack[] = [];
  for (let t = 0; t < ntracks && p < bytes.length; t++) {
    const id = tag();
    const len = rd32();
    const end = p + len;
    if (id !== 'MTrk') { p = end; t--; continue; }
    const events: MidiEvent[] = [];
    let tick = 0;
    let status = 0;
    const dec = new TextDecoder('utf-8', { fatal: false });
    while (p < end) {
      tick += vlq(end);
      let b = bytes[p]!;
      if (b & 0x80) { status = b; p++; } else if (!status) throw new MidiParseError('Running status không hợp lệ');
      b = status;
      if (b === 0xff) {
        const type = bytes[p++]!;
        const l = vlq(end);
        const d = bytes.subarray(p, p + l);
        p += l;
        status = 0;
        if (type === 0x51 && l === 3) events.push({ tick, kind: 'tempo', microsecondsPerQuarter: (d[0]! << 16) | (d[1]! << 8) | d[2]! });
        else if (type === 0x58 && l >= 2) events.push({ tick, kind: 'timeSignature', numerator: d[0]!, denominator: 2 ** d[1]! });
        else if (type === 0x59 && l === 2) events.push({ tick, kind: 'keySignature', fifths: (d[0]! << 24) >> 24, minor: d[1] === 1 });
        else if (type === 0x03) events.push({ tick, kind: 'trackName', text: dec.decode(d) });
        else if (type === 0x01) events.push({ tick, kind: 'text', text: dec.decode(d) });
        else if (type === 0x05) events.push({ tick, kind: 'lyric', text: dec.decode(d) });
        else if (type === 0x2f) { events.push({ tick, kind: 'endOfTrack' }); break; }
      } else if (b === 0xf0 || b === 0xf7) {
        const l = vlq(end);
        p += l;
        status = 0;
      } else {
        const ch = b & 0x0f;
        const hi = b & 0xf0;
        const d1 = bytes[p++]!;
        const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : bytes[p++]!;
        if (hi === 0x90 && d2 > 0) events.push({ tick, kind: 'noteOn', channel: ch, pitch: d1, velocity: d2 });
        else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) events.push({ tick, kind: 'noteOff', channel: ch, pitch: d1, velocity: d2 });
        else if (hi === 0xc0) events.push({ tick, kind: 'programChange', channel: ch, program: d1 });
        else if (hi === 0xb0) events.push({ tick, kind: 'controlChange', channel: ch, controller: d1, value: d2 });
        else if (hi === 0xe0) events.push({ tick, kind: 'pitchBend', channel: ch, value: d1 | (d2 << 7) });
      }
    }
    p = end;
    tracks.push({ events });
  }
  return { format, division, tracks };
}

function findSeq(b: Uint8Array, seq: number[]): number {
  outer: for (let i = 0; i + seq.length <= b.length; i++) {
    for (let j = 0; j < seq.length; j++) if (b[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

// ====================================================================== Score → MIDI

export function timelineToMidiFile(tl: PlaybackTimeline, title = ''): MidiFile {
  const conductor: MidiEvent[] = [];
  if (title) conductor.push({ tick: 0, kind: 'trackName', text: title });
  for (const t of tl.tempo) conductor.push({ tick: t.tick, kind: 'tempo', microsecondsPerQuarter: Math.round(60_000_000 / t.bpm) });
  for (const t of tl.timeSigs) conductor.push({ tick: t.tick, kind: 'timeSignature', numerator: t.beats, denominator: t.beatType });
  for (const k of tl.keySigs) {
    const f = k.fifths > 7 ? k.fifths - 12 : k.fifths < -7 ? k.fifths + 12 : k.fifths;
    conductor.push({ tick: k.tick, kind: 'keySignature', fifths: f, minor: k.mode === 'minor' });
  }
  const tracks: MidiTrack[] = [{ events: conductor }];
  for (const part of tl.parts) {
    const evs: MidiEvent[] = [
      { tick: 0, kind: 'trackName', text: part.name },
      { tick: 0, kind: 'programChange', channel: part.channel, program: part.program },
    ];
    for (const n of tl.notes) {
      if (n.partId !== part.partId) continue;
      evs.push({ tick: n.tick, kind: 'noteOn', channel: n.channel, pitch: n.pitch, velocity: n.velocity });
      evs.push({ tick: n.tick + n.durationTicks, kind: 'noteOff', channel: n.channel, pitch: n.pitch, velocity: 0 });
    }
    tracks.push({ events: evs });
  }
  return { format: 1, division: tl.ticksPerQuarter, tracks };
}

/** Xuất Score sang SMF type 1. Mặc định unroll repeat để file phát đúng thứ tự. */
export function exportMidi(score: ScoreDocument, opts: TimelineOptions = {}): Uint8Array {
  return writeMidiFile(timelineToMidiFile(buildTimeline(score, opts), score.meta.title));
}

// ====================================================================== MIDI → Score

export interface MidiImportOptions {
  /** Lưới lượng tử hóa theo tick (480/quarter). Mặc định 120 = nốt móc kép */
  quantizeTicks?: number;
  title?: string;
}

export interface MidiImportResult {
  score: ScoreDocument;
  warnings: string[];
}

interface RawNote { start: number; end: number; pitch: number; velocity: number }

export function importMidi(bytes: Uint8Array, opts: MidiImportOptions = {}): MidiImportResult {
  const file = parseMidiFile(bytes);
  const warnings: string[] = [];
  const q = opts.quantizeTicks ?? 120;
  const scale = TICKS_PER_QUARTER / file.division;
  const conv = (t: number) => Math.round(t * scale);
  const quant = (t: number) => Math.round(conv(t) / q) * q;

  const tempos: { tick: number; bpm: number }[] = [];
  const timeSigs: { tick: number; beats: number; beatType: number }[] = [];
  let key: { fifths: number; minor: boolean } | undefined;
  const groups = new Map<string, { name: string; channel: number; program: number; notes: RawNote[] }>();

  file.tracks.forEach((track, ti) => {
    let name = '';
    const programs = new Map<number, number>();
    const open = new Map<string, { start: number; velocity: number }[]>();
    for (const e of track.events) {
      switch (e.kind) {
        case 'trackName': name = e.text.trim(); break;
        case 'tempo': tempos.push({ tick: conv(e.tick), bpm: Math.round((60_000_000 / e.microsecondsPerQuarter) * 100) / 100 }); break;
        case 'timeSignature': timeSigs.push({ tick: quant(e.tick), beats: e.numerator, beatType: e.denominator }); break;
        case 'keySignature': key ??= { fifths: e.fifths, minor: e.minor }; break;
        case 'programChange': programs.set(e.channel, e.program); break;
        case 'noteOn': {
          const k = `${e.channel}:${e.pitch}`;
          const list = open.get(k) ?? [];
          list.push({ start: e.tick, velocity: e.velocity });
          open.set(k, list);
          break;
        }
        case 'noteOff': {
          const k = `${e.channel}:${e.pitch}`;
          const on = open.get(k)?.shift();
          if (!on) break;
          if (e.channel === 9) break;
          const gk = `${ti}:${e.channel}`;
          let g = groups.get(gk);
          if (!g) {
            g = { name, channel: e.channel, program: programs.get(e.channel) ?? 0, notes: [] };
            groups.set(gk, g);
          }
          const start = quant(on.start);
          const end = Math.max(start + q, quant(e.tick));
          g.notes.push({ start, end, pitch: e.pitch, velocity: on.velocity });
          break;
        }
      }
    }
    for (const [, g] of groups) if (!g.name) g.name = name;
  });
  if (file.tracks.some((t) => t.events.some((e) => e.kind === 'noteOn' && e.channel === 9))) {
    warnings.push('Bỏ qua kênh trống (channel 10) – ký âm bộ gõ chưa được hỗ trợ.');
  }
  if (groups.size === 0) warnings.push('File MIDI không có nốt nhạc.');

  // ---- dựng khung ô nhịp
  timeSigs.sort((a, b) => a.tick - b.tick);
  if (!timeSigs.length || timeSigs[0]!.tick > 0) timeSigs.unshift({ tick: 0, beats: 4, beatType: 4 });
  const totalEnd = Math.max(0, ...[...groups.values()].flatMap((g) => g.notes.map((n) => n.end)));

  const score = createScore({
    title: opts.title ?? 'Imported MIDI',
    parts: [],
    measures: 0,
    keyFifths: key?.fifths ?? 0,
    mode: key?.minor ? 'minor' : 'major',
    bpm: tempos.find((t) => t.tick === 0)?.bpm ?? tempos[0]?.bpm ?? 120,
  });
  score.provenance.source = 'midi';
  score.timeSigMap = [];
  score.playback.mixer = [];

  const bounds: number[] = [];
  let t = 0;
  let tsIdx = 0;
  let curTs = timeSigs[0]!;
  while (t < Math.max(totalEnd, 1)) {
    while (tsIdx + 1 < timeSigs.length && timeSigs[tsIdx + 1]!.tick <= t) curTs = timeSigs[++tsIdx]!;
    const mi = bounds.length;
    const last = score.timeSigMap[score.timeSigMap.length - 1];
    if (!last || last.beats !== curTs.beats || last.beatType !== curTs.beatType) {
      score.timeSigMap.push({ measureIndex: mi, beats: curTs.beats, beatType: curTs.beatType });
    }
    bounds.push(t);
    score.measures.push(createMeasure(mi + 1));
    t += nominalMeasureTicks(score, mi);
  }
  bounds.push(t);
  score.tempoMap = [];
  for (const tp of tempos.sort((a, b) => a.tick - b.tick)) {
    let mi = bounds.findIndex((b, i) => tp.tick >= b && tp.tick < bounds[i + 1]!);
    if (mi < 0) mi = Math.max(0, bounds.length - 2);
    const last = score.tempoMap[score.tempoMap.length - 1];
    if (last && last.bpm === tp.bpm) continue;
    score.tempoMap.push({ measureIndex: mi, offset: tp.tick - bounds[mi]!, bpm: tp.bpm });
  }
  if (!score.tempoMap.length || score.tempoMap[0]!.measureIndex !== 0 || score.tempoMap[0]!.offset !== 0) {
    score.tempoMap.unshift({ measureIndex: 0, offset: 0, bpm: 120 });
  }

  // ---- mỗi nhóm (track, channel) thành một part, một voice
  let partNo = 0;
  for (const g of groups.values()) {
    partNo++;
    const avg = g.notes.reduce((s, n) => s + n.pitch, 0) / Math.max(1, g.notes.length);
    const part: Part = {
      id: newId('p'),
      name: g.name || `Track ${partNo}`,
      abbreviation: '',
      instrument: { name: g.name || 'Piano', program: g.program, channel: g.channel, transposeChromatic: 0, transposeDiatonic: 0 },
      staves: [{ id: newId('st'), clef: avg < 57 ? { sign: 'F', line: 4 } : { sign: 'G', line: 2 } }],
      content: {},
    };
    score.parts.push(part);
    score.playback.mixer.push({ partId: part.id, volume: 0.8, pan: 0, reverb: 0.2, chorus: 0, mute: false, solo: false });
    const polyphonyTruncated = layoutNotes(score, part, g.notes, bounds, key?.fifths ?? 0);
    if (polyphonyTruncated) warnings.push(`${part.name}: nốt chồng nhau ở các thời điểm khác nhau đã được rút gọn thành một bè.`);
  }
  return { score, warnings };
}

function layoutNotes(score: ScoreDocument, part: Part, notes: RawNote[], bounds: number[], fifths: number): boolean {
  // gom theo thời điểm bắt đầu → hợp âm, cắt ở thời điểm bắt đầu kế tiếp
  const byStart = new Map<number, RawNote[]>();
  for (const n of notes) byStart.set(n.start, [...(byStart.get(n.start) ?? []), n]);
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  let truncated = false;
  const segs = starts.map((s, i) => {
    const group = byStart.get(s)!;
    const end = Math.max(...group.map((n) => n.end));
    const next = starts[i + 1] ?? Infinity;
    if (end > next) truncated = true;
    return { start: s, end: Math.min(end, next), pitches: [...new Set(group.map((n) => n.pitch))].sort((a, b) => a - b) };
  });

  const voices: Voice[][] = score.measures.map(() => [{ id: newId('v'), number: 1, events: [] }]);
  const push = (mi: number, ev: MusicEvent) => voices[mi]![0]!.events.push(ev);

  const place = (from: number, to: number, pitches: number[] | null) => {
    // tách theo vạch nhịp và theo các trường độ viết được
    const all: { mi: number; d: Duration }[] = [];
    let t = from;
    while (t < to) {
      const mi = bounds.findIndex((b, i) => t >= b && t < bounds[i + 1]!);
      if (mi < 0) break;
      const mEnd = Math.min(to, bounds[mi + 1]!);
      for (const d of ticksToDurations(mEnd - t)) all.push({ mi, d });
      t = mEnd;
    }
    all.forEach((pc, k) => {
      if (!pitches) {
        push(pc.mi, rest(pc.d));
      } else {
        const ev: ChordEvent = chord(pitches.map((p) => spellMidi(p, fifths)), pc.d);
        ev.notes.forEach((n) => {
          if (k > 0) n.tieStop = true;
          if (k < all.length - 1) n.tieStart = true;
        });
        push(pc.mi, ev);
      }
    });
  };

  let cursor = 0;
  for (const s of segs) {
    if (s.start > cursor) place(cursor, s.start, null);
    place(s.start, s.end, s.pitches);
    cursor = s.end;
  }
  const end = bounds[bounds.length - 1]!;
  if (cursor < end) place(cursor, end, null);

  score.measures.forEach((m, mi) => {
    const v = voices[mi]!;
    const evs = v[0]!.events;
    if (evs.length === 0 || (evs.every((e) => e.kind === 'rest'))) {
      v[0]!.events = [rest({ type: 'whole', dots: 0 }, 0, { measureRest: true })];
    }
    part.content[m.id] = v;
  });
  return truncated;
}
