/**
 * Đệm hợp âm như người đệm đàn thật + dạo đầu + đếm vào (karaoke).
 *
 *  - Hợp âm: lấy ký hiệu hợp âm có trong bản nhạc; nếu không có thì tự suy ra từ giai điệu (Smart Harmony).
 *  - Kiểu đệm theo nhịp: 4/4 (bass 1–3, hợp âm 2–4), 3/4 valse (bass 1, hợp âm 2–3), 2/4, 2/2, 6/8, 9/8, 12/8…
 *  - Bè trái (bass) giữ nốt gốc/quãng 5; bè phải chọn thế bấm gần thế trước nhất (dẫn giọng mượt như người đàn).
 *  - Dạo đầu: câu cuối bài (giai điệu + đệm) hoặc chuỗi I–IV–V–I với bài ngắn; sau đó đếm vào đúng số phách
 *    (trừ phách lấy đà). Toàn bộ bản nhạc được dời ra sau phần mở đầu; `preroll` cho UI hiện số đếm.
 * Không sửa bản nhạc: chỉ tạo timeline phát.
 */
import type { ChordKind, ChordSymbol, ScoreDocument } from './model.js';
import { suggestHarmony } from './harmony.js';
import { pitchToMidi } from './pitch.js';
import { nominalMeasureTicks, timeSigAt } from './score.js';
import type { MidiNoteEvent, PlaybackTimeline } from './timeline.js';

export interface PlayerSettings {
  /** Nhạc cụ phát giai điệu (GM program, 0-based); null = theo bản nhạc */
  program: number | null;
  /** Âm lượng giai điệu (0..1) */
  melodyVolume: number;
  /** Âm lượng đệm hợp âm (0..1); 0 = tắt đệm */
  chordVolume: number;
  /** Dịch giọng khi phát (nửa cung), không sửa bản nhạc */
  transpose: number;
  intro: boolean;
  countIn: boolean;
}

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = { program: null, melodyVolume: 0.85, chordVolume: 0.6, transpose: 0, intro: true, countIn: true };

export interface Preroll {
  /** Độ dài phần dạo đầu (tick) */
  introTicks: number;
  /** Độ dài phần đếm vào (tick), ngay sau dạo đầu */
  countInTicks: number;
  /** Độ dài một phách đếm */
  beatTicks: number;
  beats: number;
}

export interface AccompaniedTimeline extends PlaybackTimeline {
  preroll: Preroll;
  /** Hợp âm dùng để đệm (tick tuyệt đối, sau khi dời) — để hiện tên hợp âm khi phát */
  chordTrack: { tick: number; endTick: number; name: string }[];
}

const INTERVALS: Record<ChordKind, number[]> = {
  major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8],
  dominant: [0, 4, 7, 10], 'major-seventh': [0, 4, 7, 11], 'minor-seventh': [0, 3, 7, 10],
  'half-diminished': [0, 3, 6, 10], 'diminished-seventh': [0, 3, 6, 9],
  'suspended-fourth': [0, 5, 7], 'suspended-second': [0, 2, 7], 'major-sixth': [0, 4, 7, 9], 'minor-sixth': [0, 3, 7, 9], power: [0, 7],
};

const ACC_CHANNEL = 14;
const CLICK_CHANNEL = 9;
const PIANO = 0;

interface AbsChord {
  tick: number;
  endTick: number;
  rootPc: number;
  intervals: number[];
  name: string;
}

/** Hợp âm của bản nhạc (có sẵn hoặc tự suy ra), giữ đến khi đổi hợp âm */
export function chordsForAccompaniment(score: ScoreDocument): ChordSymbol[] {
  if (score.chordSymbols.length) return score.chordSymbols;
  try {
    return suggestHarmony(score, { style: 'sacred-hymn' })[0]?.chords ?? [];
  } catch {
    return [];
  }
}

const NAMES: Partial<Record<ChordKind, string>> = { minor: 'm', diminished: 'dim', augmented: 'aug', dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7', 'half-diminished': 'm7♭5', 'diminished-seventh': 'dim7', 'suspended-fourth': 'sus4', 'suspended-second': 'sus2', 'major-sixth': '6', 'minor-sixth': 'm6', power: '5' };
const SHARP = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Chọn thế bấm bè phải (3–4 nốt trong khoảng G3–E5) gần thế trước nhất */
function voice(rootPc: number, intervals: number[], prev: number[] | null): number[] {
  const pcs = intervals.slice(0, 4).map((i) => (rootPc + i) % 12);
  const options: number[][] = [];
  for (let inv = 0; inv < pcs.length; inv++) {
    const order = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    for (const base of [55, 60, 64]) {
      const notes: number[] = [];
      let cur = base - 1;
      for (const pc of order) {
        let n = cur + 1;
        while (n % 12 !== pc) n++;
        notes.push(n);
        cur = n;
      }
      if (notes[0]! >= 53 && notes[notes.length - 1]! <= 77) options.push(notes);
    }
  }
  if (!options.length) return pcs.map((pc) => 60 + pc);
  const center = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const target = prev ? center(prev) : 64;
  options.sort((a, b) => Math.abs(center(a) - target) - Math.abs(center(b) - target));
  return options[0]!;
}

const bassOf = (pc: number) => 40 + ((pc - 4 + 12) % 12); // E2..D#3

/** Nhịp phách đệm cho một ô: các tick tương đối + vai trò (bass gốc / bass quãng 5 / hợp âm) */
function pattern(beats: number, beatType: number, measureTicks: number): { t: number; role: 'bass' | 'bass5' | 'chord'; len: number }[] {
  const q = (480 * 4) / beatType;
  const compound = beatType === 8 && beats % 3 === 0 && beats >= 6;
  const out: { t: number; role: 'bass' | 'bass5' | 'chord'; len: number }[] = [];
  if (compound) {
    const groups = beats / 3;
    for (let g = 0; g < groups; g++) {
      const t0 = g * 3 * q;
      out.push({ t: t0, role: g % 2 === 0 ? 'bass' : 'bass5', len: 3 * q });
      out.push({ t: t0 + q, role: 'chord', len: q }, { t: t0 + 2 * q, role: 'chord', len: q });
    }
  } else if (beats === 4) {
    out.push({ t: 0, role: 'bass', len: 2 * q }, { t: q, role: 'chord', len: q }, { t: 2 * q, role: 'bass5', len: 2 * q }, { t: 3 * q, role: 'chord', len: q });
    out.push({ t: 0, role: 'chord', len: q }, { t: 2 * q, role: 'chord', len: q });
  } else if (beats === 3) {
    out.push({ t: 0, role: 'bass', len: 3 * q }, { t: q, role: 'chord', len: q }, { t: 2 * q, role: 'chord', len: q });
  } else if (beats === 2) {
    if (beatType === 2) out.push({ t: 0, role: 'bass', len: q }, { t: q / 2, role: 'chord', len: q / 2 }, { t: q, role: 'bass5', len: q }, { t: (3 * q) / 2, role: 'chord', len: q / 2 });
    else out.push({ t: 0, role: 'bass', len: 2 * q }, { t: q / 2, role: 'chord', len: q / 2 }, { t: q, role: 'bass5', len: q }, { t: (3 * q) / 2, role: 'chord', len: q / 2 });
  } else {
    for (let b = 0; b < beats; b++) out.push({ t: b * q, role: b === 0 ? 'bass' : 'chord', len: q });
  }
  return out.filter((p) => p.t < measureTicks).map((p) => ({ ...p, len: Math.min(p.len, measureTicks - p.t) }));
}

/** Nhân hoá nhẹ: độ mạnh dao động có quy luật, không ngẫu nhiên thật (phát lại giống nhau) */
const human = (tick: number) => ((tick * 2654435761) >>> 0) % 7 - 3;

/**
 * Dựng timeline phát cho Player: giai điệu (nhạc cụ / âm lượng / dịch giọng theo cài đặt) + đệm + mở đầu.
 */
export function accompany(score: ScoreDocument, base: PlaybackTimeline, s: PlayerSettings, chords: ChordSymbol[]): AccompaniedTimeline {
  const tpq = base.ticksPerQuarter;
  const transpose = s.transpose;
  const clamp = (v: number) => Math.max(1, Math.min(127, Math.round(v)));

  // ---- hợp âm theo tick tuyệt đối (theo thứ tự phát, có repeat)
  const byMeasure = new Map<string, ChordSymbol[]>();
  for (const c of chords) byMeasure.set(c.measureId, [...(byMeasure.get(c.measureId) ?? []), c]);
  for (const v of byMeasure.values()) v.sort((a, b) => a.offset - b.offset);
  const abs: AbsChord[] = [];
  for (const pm of base.measures) {
    for (const c of byMeasure.get(pm.measureId) ?? []) {
      const tick = pm.startTick + c.offset;
      const rootPc = (((pitchToMidi({ ...c.root, octave: 4 }) + transpose) % 12) + 12) % 12;
      const last = abs[abs.length - 1];
      if (last && last.tick === tick) abs.pop();
      abs.push({ tick, endTick: base.totalTicks, rootPc, intervals: INTERVALS[c.kind] ?? INTERVALS.major, name: SHARP[rootPc]! + (NAMES[c.kind] ?? '') });
    }
  }
  abs.forEach((c, i) => (c.endTick = abs[i + 1]?.tick ?? base.totalTicks));
  const chordAt = (tick: number) => {
    let found: AbsChord | undefined;
    for (const c of abs) {
      if (c.tick <= tick) found = c;
      else break;
    }
    return found ?? abs[0];
  };

  // ---- giai điệu theo cài đặt
  const melody: MidiNoteEvent[] = base.notes.map((n) => ({
    ...n,
    pitch: Math.max(0, Math.min(127, n.pitch + transpose)),
    program: s.program ?? n.program,
    velocity: clamp(n.velocity * s.melodyVolume * 1.15),
  }));

  // ---- đệm theo từng ô nhịp đã phát
  const acc: MidiNoteEvent[] = [];
  let prevVoicing: number[] | null = null;
  const accVel = (role: string, tick: number) => clamp((role === 'chord' ? 56 : 68) * s.chordVolume * 1.3 + human(tick));
  const pushChord = (tick: number, len: number, c: AbsChord, role: 'bass' | 'bass5' | 'chord', into: MidiNoteEvent[]) => {
    const vel = accVel(role, tick);
    if (vel <= 1) return;
    const mk = (pitch: number): MidiNoteEvent => ({ tick, durationTicks: Math.max(30, len - 20), channel: ACC_CHANNEL, program: PIANO, partId: '__acc', pitch, velocity: vel, noteIds: [] });
    if (role === 'chord') {
      prevVoicing = voice(c.rootPc, c.intervals, prevVoicing);
      for (const p of prevVoicing) into.push(mk(p));
    } else {
      const fifth = c.intervals.includes(7) ? 7 : c.intervals[2] ?? 7;
      into.push(mk(bassOf(role === 'bass' ? c.rootPc : (c.rootPc + fifth) % 12)));
    }
  };
  const lastIndex = base.measures.length - 1;
  if (s.chordVolume > 0 && abs.length) {
    base.measures.forEach((pm, k) => {
      const len = pm.endTick - pm.startTick;
      const nominal = nominalMeasureTicks(score, pm.measureIndex);
      const ts = timeSigAt(score, pm.measureIndex);
      if (k === 0 && len < nominal) return; // phách lấy đà: không đệm (đã có dạo đầu + đếm vào)
      if (k === lastIndex) {
        // ô cuối: một hợp âm ngân trọn ô
        const c = chordAt(pm.startTick);
        if (c) {
          pushChord(pm.startTick, len, c, 'bass', acc);
          pushChord(pm.startTick, len, c, 'chord', acc);
        }
        return;
      }
      for (const p of pattern(ts.beats, ts.beatType, len)) {
        const tick = pm.startTick + p.t;
        const c = chordAt(tick);
        if (!c) continue;
        // hợp âm đổi giữa phách bass quãng 5 → đánh nốt gốc của hợp âm mới
        const role = p.role === 'bass5' && c.tick === tick ? 'bass' : p.role;
        pushChord(tick, Math.min(p.len, c.endTick - tick), c, role, acc);
      }
    });
  }

  // ---- mở đầu: dạo đầu + đếm vào
  const firstTs = timeSigAt(score, 0);
  const q = (tpq * 4) / firstTs.beatType;
  const compound = firstTs.beatType === 8 && firstTs.beats % 3 === 0 && firstTs.beats >= 6;
  const beatTicks = compound ? q * 3 : q;
  const nominal0 = nominalMeasureTicks(score, 0);
  const first = base.measures[0];
  const pickup = first ? Math.max(0, nominal0 - (first.endTick - first.startTick)) : 0;
  const pickupLen = first && first.endTick - first.startTick < nominal0 ? first.endTick - first.startTick : 0;

  const intro: MidiNoteEvent[] = [];
  let introTicks = 0;
  if (s.intro && base.measures.length) {
    // câu cuối bài: 2 ô cuối (giai điệu + đệm)
    const tail = base.measures.length >= 6 ? base.measures.slice(-2) : [];
    if (tail.length) {
      const from = tail[0]!.startTick;
      const to = tail[tail.length - 1]!.endTick;
      introTicks = to - from;
      for (const n of [...melody, ...acc]) {
        if (n.tick >= from && n.tick < to) intro.push({ ...n, tick: n.tick - from, durationTicks: Math.min(n.durationTicks, to - n.tick), noteIds: [] });
      }
      if (!acc.length) {
        // không có đệm: thêm hợp âm chủ ngân để có cảm giác giọng
        const tonic = chordAt(to - 1);
        if (tonic) pushChord(0, introTicks, tonic, 'chord', intro);
      }
    } else {
      // bài ngắn: I – IV – V – I, mỗi hợp âm một phách đếm
      const tonic = abs[abs.length - 1] ?? abs[0];
      const rootPc = tonic?.rootPc ?? ((pitchToMidi({ step: 'C', alter: 0, octave: 4 }) + transpose) % 12);
      const prog = [0, 5, 7, 0].map((d) => ({ rootPc: (rootPc + d) % 12, intervals: d === 7 ? INTERVALS.dominant : INTERVALS.major, tick: 0, endTick: 0, name: '' }));
      prog.forEach((c, i) => {
        pushChord(i * beatTicks, beatTicks, c, 'bass', intro);
        pushChord(i * beatTicks, beatTicks, c, 'chord', intro);
      });
      introTicks = beatTicks * 4;
    }
  }
  const countInTicks = s.countIn ? Math.max(beatTicks, nominal0 - pickupLen) : 0;
  void pickup;
  const beats = Math.round(countInTicks / beatTicks);
  const clicks: MidiNoteEvent[] = [];
  for (let b = 0; b < beats; b++) {
    clicks.push({ tick: introTicks + b * beatTicks, durationTicks: 60, channel: CLICK_CHANNEL, program: 0, partId: '__click', pitch: b === 0 ? 76 : 77, velocity: 100, noteIds: [] });
  }
  const pre = introTicks + countInTicks;

  const shift = <T extends { tick: number }>(xs: T[]) => xs.map((x) => ({ ...x, tick: x.tick + pre }));
  const tempo0 = base.tempo[0] ?? { tick: 0, bpm: 90 };
  return {
    ...base,
    measures: base.measures.map((m) => ({ ...m, startTick: m.startTick + pre, endTick: m.endTick + pre })),
    spans: base.spans.map((sp) => ({ ...sp, startTick: sp.startTick + pre, endTick: sp.endTick + pre })),
    notes: [...intro, ...clicks, ...shift(melody), ...shift(acc)].sort((a, b) => a.tick - b.tick),
    tempo: [{ tick: 0, bpm: tempo0.bpm }, ...shift(base.tempo).filter((t) => t.tick > 0 || pre === 0)].filter((t, i, a) => i === 0 || t.tick !== a[i - 1]!.tick),
    timeSigs: [{ tick: 0, beats: firstTs.beats, beatType: firstTs.beatType }, ...shift(base.timeSigs).filter((t) => t.tick > 0)],
    keySigs: base.keySigs.length ? [{ ...base.keySigs[0]!, tick: 0 }, ...shift(base.keySigs).filter((t) => t.tick > 0)] : [],
    parts: [
      ...base.parts.map((p) => ({ ...p, program: s.program ?? p.program })),
      ...(acc.length || intro.length ? [{ partId: '__acc', channel: ACC_CHANNEL, program: PIANO, name: 'Đệm' }] : []),
    ],
    totalTicks: base.totalTicks + pre,
    preroll: { introTicks, countInTicks, beatTicks, beats },
    chordTrack: abs.map((c) => ({ tick: c.tick + pre, endTick: c.endTick + pre, name: c.name })),
  };
}
