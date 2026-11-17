import type { Pitch, PitchClass, Step } from './model.js';

export const STEPS: Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMITONES: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Vị trí trên vòng quãng năm của nốt tự nhiên (C = 0) */
const STEP_FIFTHS: Record<Step, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

export const mod = (a: number, n: number): number => ((a % n) + n) % n;

export function pitchToMidi(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
}

export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

/** Chỉ số diatonic tuyệt đối (C4 = 28) */
export function diatonicNumber(p: Pitch): number {
  return p.octave * 7 + stepIndex(p.step);
}

export function pitchClassFifths(pc: PitchClass): number {
  return STEP_FIFTHS[pc.step] + 7 * pc.alter;
}

export function fifthsToPitchClass(f: number): PitchClass {
  // f trong khoảng -1..5 là nốt tự nhiên; ngoài ra cộng/trừ 7 = thêm dấu thăng/giáng
  const alter = Math.floor((f + 1) / 7);
  const natural = f - 7 * alter;
  const step = (Object.keys(STEP_FIFTHS) as Step[]).find((s) => STEP_FIFTHS[s] === natural)!;
  return { step, alter };
}

/** Quãng: diatonic = số bậc (0 = đồng âm, 4 = quãng 5), chromatic = số bán cung. Có thể âm. */
export interface Interval {
  diatonic: number;
  chromatic: number;
}

export function transposePitch(p: Pitch, iv: Interval): Pitch {
  const dn = diatonicNumber(p) + iv.diatonic;
  const octave = Math.floor(dn / 7);
  const step = STEPS[mod(dn, 7)]!;
  const targetMidi = pitchToMidi(p) + iv.chromatic;
  const naturalMidi = (octave + 1) * 12 + STEP_SEMITONES[step];
  const alter = targetMidi - naturalMidi;
  const out: Pitch = { step, alter, octave };
  if (Math.abs(alter) > 2) return spellMidi(targetMidi, 0);
  return out;
}

export function transposePitchClass(pc: PitchClass, iv: Interval): PitchClass {
  const p = transposePitch({ ...pc, octave: 4 }, iv);
  return { step: p.step, alter: p.alter };
}

/** Quãng tương ứng với dịch chuyển d bậc trên vòng quãng năm, trong một quãng tám đi lên. */
export function intervalFromFifths(d: number): Interval {
  return { chromatic: mod(d * 7, 12), diatonic: mod(d * 4, 7) };
}

/** Số dịch chuyển trên vòng quãng năm của một quãng (bỏ qua quãng tám). */
export function fifthsOfInterval(iv: Interval): number {
  for (let d = -14; d <= 14; d++) {
    const c = intervalFromFifths(d);
    if (c.chromatic === mod(iv.chromatic, 12) && c.diatonic === mod(iv.diatonic, 7)) return d;
  }
  throw new Error(`Quãng không hợp lệ: ${JSON.stringify(iv)}`);
}

/**
 * Đặt tên nốt từ số MIDI theo hóa biểu (fifths): giọng có dấu thăng dùng thăng,
 * giọng có dấu giáng dùng giáng.
 */
export function spellMidi(midi: number, keyFifths: number): Pitch {
  const pc = mod(midi, 12);
  // Cửa sổ 12 quãng năm quanh giọng: các bậc của giọng + thăng/giáng thường gặp
  const lo = keyFifths - 4;
  for (let f = lo; f < lo + 12; f++) {
    const cls = fifthsToPitchClass(f);
    if (mod(STEP_SEMITONES[cls.step] + cls.alter, 12) === pc) {
      const natural = STEP_SEMITONES[cls.step] + cls.alter;
      const octave = Math.floor((midi - natural) / 12) - 1;
      return { step: cls.step, alter: cls.alter, octave };
    }
  }
  throw new Error('unreachable');
}

/** Dấu hóa của nốt tự nhiên theo hóa biểu */
export function keyAlterFor(step: Step, fifths: number): number {
  const f = STEP_FIFTHS[step];
  // Thứ tự dấu thăng F C G D A E B ứng với fifths -1..5
  if (fifths > 0) return f <= fifths - 2 ? 1 : 0;
  if (fifths < 0) return f >= 6 + fifths ? -1 : 0;
  return 0;
}

export function pitchName(p: Pitch): string {
  const acc = p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter);
  return `${p.step}${acc}${p.octave}`;
}

export function parsePitchName(s: string): Pitch {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d+)$/.exec(s.trim());
  if (!m) throw new Error(`Tên nốt không hợp lệ: ${s}`);
  const acc = m[2] ?? '';
  return {
    step: m[1]!.toUpperCase() as Step,
    alter: acc.startsWith('#') ? acc.length : -acc.length,
    octave: Number(m[3]),
  };
}
