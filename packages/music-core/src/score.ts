import { durationTicks, eventTimings, ticksToDurations, voiceTicks } from './duration.js';
import { newId } from './ids.js';
import {
  TICKS_PER_QUARTER,
  type ChordEvent, type Clef, type Duration, type Instrument, type KeySig, type LayoutSettings,
  type Measure, type MusicEvent, type Note, type Part, type Pitch, type RestEvent, type ScoreDocument,
  type TimeSig, type Voice,
} from './model.js';

export function defaultLayout(): LayoutSettings {
  return {
    pageSize: 'A4',
    pageWidthMm: 210,
    pageHeightMm: 297,
    orientation: 'portrait',
    marginsMm: { top: 15, bottom: 15, left: 15, right: 15 },
    staffSpaceMm: 1.75,
    staffSpacing: 6.5,
    systemSpacing: 9,
    firstSystemIndentMm: 8,
    preset: 'standard',
    showPageNumbers: true,
    lyricFont: 'Noto Serif',
    lyricFontSizePt: 10,
    lyricOffsetSp: 3,
    lyricVerseSpacingSp: 2.2,
    showVerseNumbers: true,
  };
}

export function createInstrument(name = 'Piano', program = 0, channel = 0): Instrument {
  return { name, program, channel, transposeChromatic: 0, transposeDiatonic: 0 };
}

export interface NewPartOptions {
  name: string;
  abbreviation?: string;
  instrument?: Instrument;
  clefs?: Clef[];
}

export function createPart(opts: NewPartOptions): Part {
  const clefs = opts.clefs ?? [{ sign: 'G', line: 2 }];
  return {
    id: newId('p'),
    name: opts.name,
    abbreviation: opts.abbreviation ?? opts.name.slice(0, 3) + '.',
    instrument: opts.instrument ?? createInstrument(opts.name),
    staves: clefs.map((clef) => ({ id: newId('st'), clef })),
    content: {},
  };
}

export function createMeasure(number: number): Measure {
  return { id: newId('m'), number: String(number), barlineRight: 'regular' };
}

export function rest(duration: Duration, staff = 0, extra: Partial<RestEvent> = {}): RestEvent {
  return { kind: 'rest', id: newId('e'), duration, staff, ...extra };
}

export function note(pitch: Pitch, extra: Partial<Note> = {}): Note {
  return { id: newId('n'), pitch, ...extra };
}

export function chord(pitches: Pitch[], duration: Duration, extra: Partial<ChordEvent> = {}): ChordEvent {
  return {
    kind: 'chord',
    id: newId('e'),
    duration,
    staff: 0,
    notes: pitches.map((p) => note(p)),
    lyrics: [],
    articulations: [],
    ...extra,
  };
}

export function fillRests(ticks: number, staff = 0): RestEvent[] {
  return ticksToDurations(ticks).map((d) => rest(d, staff));
}

export interface NewScoreOptions {
  title?: string;
  composer?: string;
  parts?: NewPartOptions[];
  measures?: number;
  keyFifths?: number;
  mode?: 'major' | 'minor';
  beats?: number;
  beatType?: number;
  bpm?: number;
  /** Độ dài ô lấy đà theo ticks (0 = không có) */
  pickupTicks?: number;
}

export function createScore(opts: NewScoreOptions = {}): ScoreDocument {
  const parts = (opts.parts ?? [{ name: 'Piano' }]).map((p, i) => {
    const part = createPart(p);
    if (!p.instrument) part.instrument.channel = i >= 9 ? i + 1 : i; // tránh kênh 10 (trống)
    return part;
  });
  const n = opts.measures ?? 4;
  const score: ScoreDocument = {
    schemaVersion: 1,
    id: newId('sc'),
    revision: 0,
    meta: {
      title: opts.title ?? 'Untitled',
      subtitle: '',
      composer: opts.composer ?? '',
      lyricist: '',
      arranger: '',
      copyright: '',
    },
    parts,
    measures: [],
    keyMap: [{ measureIndex: 0, fifths: opts.keyFifths ?? 0, mode: opts.mode ?? 'major' }],
    timeSigMap: [{ measureIndex: 0, beats: opts.beats ?? 4, beatType: opts.beatType ?? 4 }],
    tempoMap: [{ measureIndex: 0, offset: 0, bpm: opts.bpm ?? 100 }],
    chordSymbols: [],
    dynamics: [],
    layout: defaultLayout(),
    playback: {
      soundFont: 'default',
      speed: 1,
      transposeSemitones: 0,
      metronome: false,
      countInBars: 0,
      mixer: parts.map((p) => ({ partId: p.id, volume: 0.8, pan: 0, reverb: 0.2, chorus: 0, mute: false, solo: false })),
    },
    aiMeta: { jobs: [] },
    provenance: { source: 'new', unverifiedEventIds: [] },
  };
  for (let i = 0; i < n; i++) {
    const m = createMeasure(i + 1);
    if (i === 0 && opts.pickupTicks) {
      m.pickup = true;
      m.actualTicks = opts.pickupTicks;
      m.number = '0';
    }
    score.measures.push(m);
  }
  if (opts.pickupTicks) score.measures.forEach((m, i) => (m.number = String(i)));
  for (const part of score.parts) {
    for (let i = 0; i < n; i++) ensureMeasureContent(score, part, i);
  }
  return score;
}

/** Đảm bảo mỗi khuông của part có ít nhất voice 1 lấp đầy dấu lặng. */
export function ensureMeasureContent(score: ScoreDocument, part: Part, measureIndex: number): Voice[] {
  const m = score.measures[measureIndex]!;
  let voices = part.content[m.id];
  if (!voices) {
    voices = part.staves.map((_, s) => ({
      id: newId('v'),
      number: s * 4 + 1,
      events: [measureRestEvent(score, measureIndex, s)],
    }));
    part.content[m.id] = voices;
  }
  return voices;
}

export function measureRestEvent(_score: ScoreDocument, _measureIndex: number, staff: number): RestEvent {
  // Dấu lặng nguyên ô: ký hiệu là dấu lặng tròn nhưng luôn chiếm đúng độ dài ô (kể cả 3/4, 6/8)
  return rest({ type: 'whole', dots: 0 }, staff, { measureRest: true });
}

export function keyAt(score: ScoreDocument, measureIndex: number): KeySig {
  let k = score.keyMap[0]!;
  for (const x of score.keyMap) if (x.measureIndex <= measureIndex) k = x;
  return k;
}

export function timeSigAt(score: ScoreDocument, measureIndex: number): TimeSig {
  let t = score.timeSigMap[0]!;
  for (const x of score.timeSigMap) if (x.measureIndex <= measureIndex) t = x;
  return t;
}

/** Độ dài danh nghĩa (theo số chỉ nhịp) */
export function nominalMeasureTicks(score: ScoreDocument, measureIndex: number): number {
  const ts = timeSigAt(score, measureIndex);
  return (ts.beats * 4 * TICKS_PER_QUARTER) / ts.beatType;
}

/** Độ dài thực của ô nhịp (ô lấy đà có thể ngắn hơn) */
export function measureTicks(score: ScoreDocument, measureIndex: number): number {
  const m = score.measures[measureIndex]!;
  if (m.actualTicks) return m.actualTicks;
  return nominalMeasureTicks(score, measureIndex);
}

/** Ticks của event, dấu lặng nguyên ô luôn bằng độ dài ô nhịp */
export function eventTicksIn(score: ScoreDocument, measureIndex: number, events: MusicEvent[]) {
  const timings = eventTimings(events);
  return events.map((ev, i) => {
    if (ev.kind === 'rest' && ev.measureRest) return { start: 0, ticks: measureTicks(score, measureIndex) };
    return timings[i]!;
  });
}

export function measureStartTicks(score: ScoreDocument): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < score.measures.length; i++) {
    out.push(t);
    t += measureTicks(score, i);
  }
  out.push(t);
  return out;
}

// ---------------------------------------------------------------- Tra cứu theo ID

export interface EventLocation {
  part: Part;
  partIndex: number;
  measure: Measure;
  measureIndex: number;
  voice: Voice;
  eventIndex: number;
  event: MusicEvent;
}

export interface NoteLocation extends EventLocation {
  event: ChordEvent;
  note: Note;
}

export class ScoreIndex {
  private events = new Map<string, EventLocation>();
  private notes = new Map<string, NoteLocation>();
  private measureIdx = new Map<string, number>();

  constructor(score: ScoreDocument) {
    score.measures.forEach((m, i) => this.measureIdx.set(m.id, i));
    score.parts.forEach((part, partIndex) => {
      score.measures.forEach((measure, measureIndex) => {
        for (const voice of part.content[measure.id] ?? []) {
          voice.events.forEach((event, eventIndex) => {
            const loc: EventLocation = { part, partIndex, measure, measureIndex, voice, eventIndex, event };
            this.events.set(event.id, loc);
            if (event.kind === 'chord') for (const n of event.notes) this.notes.set(n.id, { ...loc, event, note: n });
          });
        }
      });
    });
  }

  event(id: string): EventLocation | undefined {
    return this.events.get(id);
  }
  note(id: string): NoteLocation | undefined {
    return this.notes.get(id);
  }
  measureIndex(id: string): number | undefined {
    return this.measureIdx.get(id);
  }
  allNoteIds(): string[] {
    return [...this.notes.keys()];
  }
}

// ---------------------------------------------------------------- Kiểm tra cấu trúc

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: 'MEASURE_UNDERFULL' | 'MEASURE_OVERFULL' | 'DUPLICATE_ID' | 'BAD_PITCH' | 'TIE_MISMATCH';
  message: string;
  partId?: string;
  measureId?: string;
  elementId?: string;
}

export function validateScore(score: ScoreDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const check = (id: string) => {
    if (seen.has(id)) issues.push({ severity: 'error', code: 'DUPLICATE_ID', message: `ID trùng: ${id}`, elementId: id });
    seen.add(id);
  };
  score.measures.forEach((m) => check(m.id));
  for (const part of score.parts) {
    check(part.id);
    score.measures.forEach((m, mi) => {
      const expected = measureTicks(score, mi);
      for (const v of part.content[m.id] ?? []) {
        check(v.id);
        for (const ev of v.events) {
          check(ev.id);
          if (ev.kind === 'chord') {
            for (const n of ev.notes) {
              check(n.id);
              if (Math.abs(n.pitch.alter) > 2 || n.pitch.octave < -1 || n.pitch.octave > 9) {
                issues.push({ severity: 'error', code: 'BAD_PITCH', message: 'Cao độ ngoài phạm vi', elementId: n.id });
              }
            }
          }
        }
        if (v.events.length === 1 && v.events[0]!.kind === 'rest' && v.events[0]!.measureRest) continue;
        const actual = voiceTicks(v.events);
        if (actual > expected) {
          issues.push({ severity: 'error', code: 'MEASURE_OVERFULL', message: `Ô ${m.number} thừa ${actual - expected} tick`, partId: part.id, measureId: m.id });
        } else if (actual < expected && v.number % 4 === 1) {
          issues.push({ severity: 'warning', code: 'MEASURE_UNDERFULL', message: `Ô ${m.number} thiếu ${expected - actual} tick`, partId: part.id, measureId: m.id });
        }
      }
    });
  }
  return issues;
}

export { durationTicks };
