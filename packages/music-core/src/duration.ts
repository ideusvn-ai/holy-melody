import { TICKS_PER_QUARTER, type Duration, type DurationType, type MusicEvent } from './model.js';

export const DURATION_TYPES: DurationType[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];

const BASE_QUARTERS: Record<DurationType, [number, number]> = {
  whole: [4, 1],
  half: [2, 1],
  quarter: [1, 1],
  eighth: [1, 2],
  '16th': [1, 4],
  '32nd': [1, 8],
  '64th': [1, 16],
};

/** Phân số tối giản, mẫu dương. Dùng để tính vị trí tuplet chính xác. */
export interface Rational {
  n: number;
  d: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function rat(n: number, d = 1): Rational {
  if (d === 0) throw new Error('Mẫu số bằng 0');
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const ratAdd = (a: Rational, b: Rational): Rational => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const ratMul = (a: Rational, b: Rational): Rational => rat(a.n * b.n, a.d * b.d);

/** Độ dài tính bằng số phần tư (quarter) dưới dạng phân số chính xác. */
export function durationQuarters(d: Duration): Rational {
  const [bn, bd] = BASE_QUARTERS[d.type];
  // dots: base * (2 - 1/2^dots)
  const p = 2 ** d.dots;
  let q = rat(bn * (2 * p - 1), bd * p);
  if (d.tuplet) q = ratMul(q, rat(d.tuplet.normal, d.tuplet.actual));
  return q;
}

/** Ticks của một duration đứng riêng (làm tròn xuống nếu tuplet không chia hết). */
export function durationTicks(d: Duration): number {
  const q = durationQuarters(d);
  return Math.floor((q.n * TICKS_PER_QUARTER) / q.d);
}

/**
 * Vị trí bắt đầu (ticks) và độ dài (ticks) của từng event trong một voice.
 * Tính bằng phân số rồi mới đổi ra tick, nên tổng nhóm tuplet luôn chính xác.
 * Nốt hoa mỹ (grace) có độ dài 0.
 */
export function eventTimings(events: MusicEvent[]): { start: number; ticks: number }[] {
  const out: { start: number; ticks: number }[] = [];
  let pos = rat(0);
  const toTick = (r: Rational) => Math.floor((r.n * TICKS_PER_QUARTER) / r.d);
  for (const ev of events) {
    const isGrace = ev.kind === 'chord' && ev.grace;
    const len = isGrace ? rat(0) : durationQuarters(ev.duration);
    const next = ratAdd(pos, len);
    const start = toTick(pos);
    out.push({ start, ticks: toTick(next) - start });
    pos = next;
  }
  return out;
}

export function voiceTicks(events: MusicEvent[]): number {
  const t = eventTimings(events);
  if (t.length === 0) return 0;
  const last = t[t.length - 1]!;
  return last.start + last.ticks;
}

/**
 * Phân tích một độ dài tick thành dãy duration có thể viết (dùng khi import MIDI,
 * điền dấu lặng, tách nốt qua vạch nhịp). Ưu tiên nốt chấm dôi đơn.
 */
export function ticksToDurations(ticks: number): Duration[] {
  const candidates: { d: Duration; t: number }[] = [];
  for (const type of DURATION_TYPES) {
    for (const dots of [1, 0]) {
      const d: Duration = { type, dots };
      candidates.push({ d, t: durationTicks(d) });
    }
  }
  candidates.sort((a, b) => b.t - a.t);
  const out: Duration[] = [];
  let rest = ticks;
  while (rest > 0) {
    const c = candidates.find((x) => x.t <= rest && x.t > 0);
    if (!c) break; // nhỏ hơn 64th: bỏ qua phần dư
    out.push({ ...c.d });
    rest -= c.t;
  }
  return out;
}

/** Tìm duration khớp đúng một số tick (kể cả liên ba phổ biến). */
export function exactDurationForTicks(ticks: number): Duration | undefined {
  for (const type of DURATION_TYPES) {
    for (const dots of [0, 1, 2]) {
      const d: Duration = { type, dots };
      if (durationTicks(d) === ticks) return d;
    }
    const trip: Duration = { type, dots: 0, tuplet: { actual: 3, normal: 2 } };
    if (durationTicks(trip) === ticks) return trip;
  }
  return undefined;
}
