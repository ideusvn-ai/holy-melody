/**
 * Chuyển giọng: toàn bài, theo part, theo dải ô nhịp.
 * Cập nhật nốt, dấu hóa (qua cách viết tên nốt đúng), hợp âm và hóa biểu.
 */
import type { ScoreDocument } from './model.js';
import { fifthsOfInterval, intervalFromFifths, mod, transposePitch, transposePitchClass, type Interval } from './pitch.js';

export type TransposeSpec =
  | { by: 'semitones'; semitones: number }
  | { by: 'interval'; interval: Interval }
  | { by: 'key'; targetFifths: number; direction: 'closest' | 'up' | 'down' };

export interface TransposeScope {
  partIds?: string[];
  /** [from, to] chỉ số ô nhịp, bao gồm */
  measureRange?: [number, number];
  /** Có đổi hóa biểu không (mặc định: true khi chuyển toàn bộ part) */
  updateKeySignature?: boolean;
  /** Dịch thêm quãng tám để giữ âm vực */
  octaveShift?: number;
}

/** Quy đổi yêu cầu thành một quãng cụ thể, chọn cách viết ít dấu hóa nhất. */
export function resolveInterval(spec: TransposeSpec, currentFifths: number): Interval {
  if (spec.by === 'interval') return spec.interval;
  if (spec.by === 'semitones') {
    const n = spec.semitones;
    // các d trên vòng quãng năm cho cùng số bán cung (mod 12)
    let d0 = 0;
    for (let d = -6; d <= 6; d++) if (mod(d * 7, 12) === mod(n, 12)) d0 = d;
    const candidates = [d0 - 12, d0, d0 + 12].filter((d) => Math.abs(currentFifths + d) <= 7);
    const d = candidates.sort((a, b) => Math.abs(currentFifths + a) - Math.abs(currentFifths + b))[0] ?? d0;
    const base = intervalFromFifths(d);
    const oct = Math.round((n - base.chromatic) / 12);
    return { chromatic: base.chromatic + 12 * oct, diatonic: base.diatonic + 7 * oct };
  }
  const d = spec.targetFifths - currentFifths;
  const up = intervalFromFifths(d);
  const down = { chromatic: up.chromatic - 12, diatonic: up.diatonic - 7 };
  if (up.chromatic === 0) return { chromatic: 0, diatonic: 0 };
  if (spec.direction === 'up') return up;
  if (spec.direction === 'down') return down;
  return up.chromatic <= 6 ? up : down;
}

/** Áp dụng chuyển giọng (mutate). Trả về quãng đã dùng. Dùng qua Command để có undo. */
export function transposeScore(score: ScoreDocument, spec: TransposeSpec, scope: TransposeScope = {}): Interval {
  const firstKey = score.keyMap[0]?.fifths ?? 0;
  let iv = resolveInterval(spec, firstKey);
  if (scope.octaveShift) iv = { chromatic: iv.chromatic + 12 * scope.octaveShift, diatonic: iv.diatonic + 7 * scope.octaveShift };
  const [from, to] = scope.measureRange ?? [0, score.measures.length - 1];
  const parts = score.parts.filter((p) => !scope.partIds || scope.partIds.includes(p.id));
  const inRange = (i: number) => i >= from && i <= to;

  for (const part of parts) {
    score.measures.forEach((m, mi) => {
      if (!inRange(mi)) return;
      for (const v of part.content[m.id] ?? []) {
        for (const ev of v.events) {
          if (ev.kind !== 'chord') continue;
          for (const n of ev.notes) n.pitch = transposePitch(n.pitch, iv);
        }
      }
    });
  }
  const measureIndex = new Map(score.measures.map((m, i) => [m.id, i]));
  const partIds = new Set(parts.map((p) => p.id));
  for (const c of score.chordSymbols) {
    if (!partIds.has(c.partId) || !inRange(measureIndex.get(c.measureId) ?? -1)) continue;
    c.root = transposePitchClass(c.root, iv);
    if (c.bass) c.bass = transposePitchClass(c.bass, iv);
  }

  const whole = !scope.partIds && !scope.measureRange;
  if (scope.updateKeySignature ?? whole) {
    const delta = fifthsOfInterval(iv);
    for (const k of score.keyMap) {
      if (!inRange(k.measureIndex)) continue;
      let f = k.fifths + delta;
      if (f > 7) f -= 12;
      if (f < -7) f += 12;
      k.fifths = f;
    }
  }
  return iv;
}
