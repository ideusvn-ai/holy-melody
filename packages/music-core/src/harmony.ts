/**
 * Smart Harmony (cục bộ, offline, không tốn credit).
 *
 * Gợi ý ký hiệu hợp âm cho giai điệu bằng hòa âm chức năng:
 *   1. Chia giai điệu thành các đoạn (ô nhịp / nửa ô / phách)
 *   2. Chấm điểm mỗi hợp âm ứng viên theo mức "chứa" các nốt giai điệu (nốt dài, nốt phách mạnh nặng ký hơn)
 *   3. Chọn chuỗi hợp âm tốt nhất bằng Viterbi với điểm chuyển hợp âm (T → S → D → T, cadence cuối câu / cuối bài)
 *   4. Sinh nhiều phương án (Đơn giản / Phong phú / theo phong cách)
 * KHÔNG bao giờ thay đổi nốt giai điệu: kết quả chỉ là danh sách ChordSymbol, áp dụng qua Command (có Undo).
 * Bản "AI Harmony" (tính credit, Phase 5) sẽ trả về cùng định dạng HarmonyVariant.
 */
import { durationTicks } from './duration.js';
import type { Command } from './history.js';
import { newId } from './ids.js';
import type { ChordKind, ChordSymbol, PitchClass, ScoreDocument } from './model.js';
import { fifthsToPitchClass, mod, pitchToMidi, transposePitchClass } from './pitch.js';
import { eventTicksIn, keyAt, measureTicks, timeSigAt } from './score.js';
import { endsPhrase } from './vietnamese.js';

export type HarmonyStyle = 'sacred-hymn' | 'classical' | 'traditional' | 'pop' | 'ballad' | 'acoustic' | 'worship' | 'gospel' | 'jazz';
export type HarmonyRhythm = 'auto' | 'measure' | 'half' | 'beat';

export const HARMONY_STYLES: { id: HarmonyStyle; label: string }[] = [
  { id: 'sacred-hymn', label: 'Thánh ca' },
  { id: 'classical', label: 'Cổ điển' },
  { id: 'traditional', label: 'Truyền thống' },
  { id: 'worship', label: 'Worship' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'pop', label: 'Pop' },
  { id: 'acoustic', label: 'Acoustic' },
  { id: 'gospel', label: 'Gospel' },
  { id: 'jazz', label: 'Jazz' },
];

export interface HarmonyOptions {
  /** Part chứa giai điệu (mặc định part đầu tiên) */
  partId?: string;
  /** [from, to] chỉ số ô nhịp; mặc định toàn bài */
  measureRange?: [number, number];
  style?: HarmonyStyle;
  rhythm?: HarmonyRhythm;
  /** Thay đổi để "Regenerate" ra phương án khác (0 = mặc định) */
  seed?: number;
}

export interface HarmonyVariant {
  id: string;
  label: string;
  description: string;
  /** Ký hiệu hợp âm đề xuất (gắn vào partId, chưa áp dụng) */
  chords: ChordSymbol[];
  /** Bậc hợp âm theo thứ tự, vd ["I", "IV", "V7", "I"] */
  numerals: string[];
  /** Điểm phù hợp tương đối (cao hơn = khớp giai điệu + cadence tốt hơn) */
  score: number;
}

// ---------------------------------------------------------------- hợp âm ứng viên

type Func = 'T' | 'S' | 'D';

interface Candidate {
  numeral: string;
  degree: number; // 0..6
  /** dịch bán cung của gốc so với bậc tự nhiên của gam (vd hợp âm bậc V trong thứ hòa âm) */
  rootAlter: number;
  kind: ChordKind;
  func: Func;
  /** Hợp âm át phụ: chỉ hợp lý khi đi tới bậc đích */
  resolvesTo?: number;
}

const KIND_INTERVALS: Record<ChordKind, number[]> = {
  major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8],
  dominant: [0, 4, 7, 10], 'major-seventh': [0, 4, 7, 11], 'minor-seventh': [0, 3, 7, 10],
  'half-diminished': [0, 3, 6, 10], 'diminished-seventh': [0, 3, 6, 9], 'suspended-fourth': [0, 5, 7],
  'suspended-second': [0, 2, 7], 'major-sixth': [0, 4, 7, 9], 'minor-sixth': [0, 3, 7, 9], power: [0, 7],
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

function candidates(mode: 'major' | 'minor', palette: 'simple' | 'rich' | 'seventh'): Candidate[] {
  const c = (numeral: string, degree: number, kind: ChordKind, func: Func, rootAlter = 0, resolvesTo?: number): Candidate =>
    ({ numeral, degree, kind, func, rootAlter, resolvesTo });
  if (mode === 'major') {
    if (palette === 'seventh') {
      return [c('Imaj7', 0, 'major-seventh', 'T'), c('ii7', 1, 'minor-seventh', 'S'), c('iii7', 2, 'minor-seventh', 'T'),
        c('IVmaj7', 3, 'major-seventh', 'S'), c('V7', 4, 'dominant', 'D'), c('vi7', 5, 'minor-seventh', 'T'),
        c('viiø7', 6, 'half-diminished', 'D'), c('V7/V', 1, 'dominant', 'D', 0, 4), c('V7/ii', 5, 'dominant', 'D', 0, 1)];
    }
    const base = [c('I', 0, 'major', 'T'), c('ii', 1, 'minor', 'S'), c('IV', 3, 'major', 'S'), c('V', 4, 'major', 'D'),
      c('V7', 4, 'dominant', 'D'), c('vi', 5, 'minor', 'T')];
    if (palette === 'simple') return base;
    return [...base, c('iii', 2, 'minor', 'T'), c('vii°', 6, 'diminished', 'D'),
      c('V/V', 1, 'major', 'D', 0, 4), c('V7/vi', 2, 'dominant', 'D', 0, 5)];
  }
  // giọng thứ: dùng thứ hòa âm cho bậc V và vii°
  if (palette === 'seventh') {
    return [c('i7', 0, 'minor-seventh', 'T'), c('iiø7', 1, 'half-diminished', 'S'), c('IIImaj7', 2, 'major-seventh', 'T'),
      c('iv7', 3, 'minor-seventh', 'S'), c('V7', 4, 'dominant', 'D'), c('VImaj7', 5, 'major-seventh', 'S'), c('vii°7', 6, 'diminished-seventh', 'D', 1)];
  }
  const base = [c('i', 0, 'minor', 'T'), c('iv', 3, 'minor', 'S'), c('V', 4, 'major', 'D'), c('V7', 4, 'dominant', 'D'), c('VI', 5, 'major', 'T')];
  if (palette === 'simple') return base;
  return [...base, c('III', 2, 'major', 'T'), c('ii°', 1, 'diminished', 'S'), c('VII', 6, 'major', 'D'), c('vii°', 6, 'diminished', 'D', 1)];
}

// ---------------------------------------------------------------- phong cách

interface StyleProfile {
  palette: 'simple' | 'rich' | 'seventh';
  /** thưởng cho chuỗi điển hình, theo cặp numeral "A>B" */
  favourite: Record<string, number>;
  /** phạt hợp âm 7 (trừ V7) khi phong cách không dùng */
  seventhPenalty: number;
}

const STYLE: Record<HarmonyStyle, StyleProfile> = {
  'sacred-hymn': { palette: 'rich', favourite: { 'IV>I': 0.3, 'ii>V': 0.3, 'V7>I': 0.3, 'iv>i': 0.3 }, seventhPenalty: 0.6 },
  classical: { palette: 'rich', favourite: { 'ii>V': 0.4, 'V/V>V': 0.4, 'vii°>I': 0.2 }, seventhPenalty: 0.4 },
  traditional: { palette: 'simple', favourite: { 'IV>I': 0.3, 'V>I': 0.3 }, seventhPenalty: 0.8 },
  worship: { palette: 'rich', favourite: { 'I>V': 0.3, 'V>vi': 0.4, 'vi>IV': 0.4, 'IV>I': 0.3 }, seventhPenalty: 0.8 },
  ballad: { palette: 'rich', favourite: { 'I>vi': 0.3, 'vi>IV': 0.3, 'IV>V': 0.3, 'iii>vi': 0.3 }, seventhPenalty: 0.5 },
  pop: { palette: 'simple', favourite: { 'I>V': 0.4, 'V>vi': 0.5, 'vi>IV': 0.5, 'IV>I': 0.3 }, seventhPenalty: 0.8 },
  acoustic: { palette: 'simple', favourite: { 'I>IV': 0.3, 'IV>V': 0.3, 'vi>IV': 0.3 }, seventhPenalty: 0.8 },
  gospel: { palette: 'rich', favourite: { 'IV>I': 0.5, 'V/V>V': 0.3, 'I>IV': 0.3 }, seventhPenalty: 0.1 },
  jazz: { palette: 'seventh', favourite: { 'ii7>V7': 0.8, 'V7>Imaj7': 0.6, 'vi7>ii7': 0.4, 'iiø7>V7': 0.8, 'V7>i7': 0.6 }, seventhPenalty: 0 },
};

/** Điểm chuyển theo chức năng */
const FUNC_MOVE: Record<Func, Record<Func, number>> = {
  T: { T: 0.15, S: 0.9, D: 0.7 },
  S: { T: 0.45, S: 0.2, D: 0.95 },
  D: { T: 1.1, S: -0.7, D: 0.1 },
};

// ---------------------------------------------------------------- phân đoạn giai điệu

interface Segment {
  measureIndex: number;
  measureId: string;
  offset: number;
  length: number;
  /** (pitch class, trọng số) */
  notes: { pc: number; w: number }[];
  phraseEnd: boolean;
}

function segments(score: ScoreDocument, partId: string, range: [number, number], rhythm: HarmonyRhythm): Segment[] {
  const part = score.parts.find((p) => p.id === partId);
  if (!part) throw new Error('Không tìm thấy bè giai điệu');
  const out: Segment[] = [];
  for (let mi = range[0]; mi <= range[1]; mi++) {
    const m = score.measures[mi]!;
    const len = measureTicks(score, mi);
    const ts = timeSigAt(score, mi);
    const beat = (4 * 480) / ts.beatType;
    const compound = ts.beatType === 8 && ts.beats % 3 === 0;
    const voice = (part.content[m.id] ?? [])[0];
    const events = voice?.events ?? [];
    const timings = eventTicksIn(score, mi, events);
    const noteCount = events.filter((e) => e.kind === 'chord').length;
    let r = rhythm;
    if (r === 'auto') r = ts.beats === 4 && ts.beatType === 4 && noteCount >= 4 ? 'half' : 'measure';
    let segLen = len;
    if (!m.pickup) {
      if (r === 'half' && ts.beats % 2 === 0) segLen = len / 2;
      if (r === 'beat') segLen = compound ? beat * 3 : beat;
    }
    for (let off = 0; off < len; off += segLen) {
      const seg: Segment = { measureIndex: mi, measureId: m.id, offset: off, length: Math.min(segLen, len - off), notes: [], phraseEnd: false };
      events.forEach((ev, i) => {
        const { start, ticks } = timings[i]!;
        const s = Math.max(start, off);
        const e = Math.min(start + ticks, off + segLen);
        if (ev.kind !== 'chord' || ev.grace || e <= s) return;
        const top = ev.notes.reduce((a, b) => (pitchToMidi(b.pitch) > pitchToMidi(a.pitch) ? b : a));
        const strong = start === off ? 1.6 : start % beat === 0 ? 1.2 : 0.8;
        seg.notes.push({ pc: mod(pitchToMidi(top.pitch), 12), w: (e - s) * strong });
        if (start + ticks >= off + segLen - 1 && (ev.articulations.includes('fermata') || ev.lyrics.some((l) => endsPhrase(l.text)))) seg.phraseEnd = true;
      });
      // dấu lặng ở cuối đoạn → hết câu
      const lastEv = events[events.length - 1];
      if (off + segLen >= len && lastEv?.kind === 'rest' && !lastEv.hidden && durationTicks(lastEv.duration) >= beat) seg.phraseEnd = true;
      out.push(seg);
    }
  }
  return out;
}

// ---------------------------------------------------------------- chấm điểm + Viterbi

function chordPcs(tonicPc: number, scale: number[], c: Candidate): Set<number> {
  const root = mod(tonicPc + scale[c.degree]! + c.rootAlter + (c.resolvesTo !== undefined ? secondaryShift(scale, c) : 0), 12);
  return new Set(KIND_INTERVALS[c.kind].map((i) => mod(root + i, 12)));
}

/** Át phụ: gốc là bậc 5 của bậc đích (vd V/V trong Đô trưởng = D) */
function secondaryShift(scale: number[], c: Candidate): number {
  const target = scale[c.resolvesTo!]!;
  const wanted = mod(target + 7, 12);
  return mod(wanted - scale[c.degree]!, 12) > 6 ? mod(wanted - scale[c.degree]!, 12) - 12 : mod(wanted - scale[c.degree]!, 12);
}

function fit(seg: Segment, pcs: Set<number>): number {
  const total = seg.notes.reduce((a, n) => a + n.w, 0);
  if (!total) return 0;
  let s = 0;
  for (const n of seg.notes) s += pcs.has(n.pc) ? n.w : -0.7 * n.w;
  return (s / total) * 3;
}

/** Nhiễu nhỏ xác định theo seed để "Regenerate" ra phương án khác nhưng vẫn hợp lý */
function jitter(seed: number, a: number, b: number): number {
  if (!seed) return 0;
  const x = Math.sin(seed * 9301 + a * 49297 + b * 233280) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.5;
}

function solve(segs: Segment[], cands: Candidate[], tonicPc: number, scale: number[], style: StyleProfile, seed: number, isWholePiece: boolean): { path: number[]; score: number } {
  const pcs = cands.map((c) => chordPcs(tonicPc, scale, c));
  const n = segs.length;
  const K = cands.length;
  const local = (i: number, k: number): number => {
    const c = cands[k]!;
    const seg = segs[i]!;
    let s = seg.notes.length ? fit(seg, pcs[k]!) : 0;
    if (c.kind !== 'major' && c.kind !== 'minor' && c.kind !== 'diminished' && c.numeral !== 'V7') s -= style.seventhPenalty;
    if (c.kind === 'diminished') s -= 0.4;
    if (c.resolvesTo !== undefined) s -= 0.45; // át phụ: dùng có chọn lọc
    if (i === 0 && !(score0Pickup(segs) && c.func === 'D')) s += c.degree === 0 && c.func === 'T' ? 0.9 : 0;
    if (seg.phraseEnd) s += c.degree === 0 ? 0.6 : c.degree === 4 ? 0.7 : -0.3;
    if (i === n - 1 && isWholePiece) s += c.degree === 0 && c.func === 'T' ? 3 : -3;
    if (i === n - 2 && isWholePiece) s += c.degree === 4 ? 1 : c.func === 'S' ? 0.3 : 0;
    // V7 thay V chủ yếu ở cadence
    if (c.numeral === 'V7' && !(i === n - 2 || segs[i]!.phraseEnd || segs[i + 1]?.phraseEnd)) s -= 0.25;
    return s + jitter(seed, i, k);
  };
  const trans = (a: number, b: number, i: number): number => {
    const A = cands[a]!;
    const B = cands[b]!;
    let s = FUNC_MOVE[A.func][B.func];
    if (A.numeral === B.numeral) s += segs[i]!.measureIndex === segs[i - 1]!.measureIndex ? -0.6 : -0.2;
    if (A.resolvesTo !== undefined) s += B.degree === A.resolvesTo ? 1.2 : -2;
    s += style.favourite[`${A.numeral}>${B.numeral}`] ?? 0;
    return s;
  };
  const dp: number[][] = Array.from({ length: n }, () => new Array<number>(K).fill(-Infinity));
  const back: number[][] = Array.from({ length: n }, () => new Array<number>(K).fill(0));
  for (let k = 0; k < K; k++) dp[0]![k] = local(0, k);
  for (let i = 1; i < n; i++) {
    for (let b = 0; b < K; b++) {
      const l = local(i, b);
      for (let a = 0; a < K; a++) {
        const v = dp[i - 1]![a]! + trans(a, b, i) + l;
        if (v > dp[i]![b]!) {
          dp[i]![b] = v;
          back[i]![b] = a;
        }
      }
    }
  }
  let best = 0;
  for (let k = 1; k < K; k++) if (dp[n - 1]![k]! > dp[n - 1]![best]!) best = k;
  const path = new Array<number>(n);
  path[n - 1] = best;
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i]![path[i]!]!;
  return { path, score: dp[n - 1]![best]! / Math.max(1, n) };
}

const score0Pickup = (segs: Segment[]) => segs.length > 1 && segs[0]!.measureIndex !== segs[1]!.measureIndex && segs[0]!.length < segs[1]!.length;

// ---------------------------------------------------------------- API

export function suggestHarmony(score: ScoreDocument, opts: HarmonyOptions = {}): HarmonyVariant[] {
  const part = opts.partId ? score.parts.find((p) => p.id === opts.partId) : score.parts[0];
  if (!part) throw new Error('Bản nhạc chưa có bè nào');
  const range: [number, number] = opts.measureRange ?? [0, score.measures.length - 1];
  const styleId = opts.style ?? 'sacred-hymn';
  const style = STYLE[styleId];
  const key = keyAt(score, range[0]);
  const tonic: PitchClass = fifthsToPitchClass(key.mode === 'minor' ? key.fifths + 3 : key.fifths);
  const tonicPc = mod(pitchToMidi({ ...tonic, octave: 4 }), 12);
  const scale = key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
  const segs = segments(score, part.id, range, opts.rhythm ?? 'auto');
  if (!segs.some((s) => s.notes.length)) return [];
  const whole = range[1] === score.measures.length - 1;
  const seed = opts.seed ?? 0;

  const configs: { label: string; description: string; profile: StyleProfile }[] = [
    { label: 'Đơn giản', description: 'Chủ yếu ba hợp âm chính I – IV – V (và vi), dễ đệm, dễ hát theo.', profile: { ...style, palette: 'simple', seventhPenalty: Math.max(style.seventhPenalty, 0.6) } },
    { label: 'Phong phú', description: 'Thêm hợp âm phụ (ii, iii, vii°) và át phụ (V/V) tạo màu sắc hòa âm.', profile: { ...style, palette: style.palette === 'seventh' ? 'seventh' : 'rich' } },
    { label: HARMONY_STYLES.find((s) => s.id === styleId)!.label, description: `Ưu tiên chuỗi hợp âm đặc trưng của phong cách ${HARMONY_STYLES.find((s) => s.id === styleId)!.label}.`, profile: style },
  ];

  const out: HarmonyVariant[] = [];
  const seen = new Set<string>();
  configs.forEach((cfg, vi) => {
    const cands = candidates(key.mode, cfg.profile.palette);
    // Nếu trùng phương án trước, thử lại với nhiễu nhỏ để luôn có lựa chọn khác biệt
    for (let attempt = 0; attempt < 6; attempt++) {
    const { path, score: sc } = solve(segs, cands, tonicPc, scale, cfg.profile, (seed ? seed + vi : 0) + attempt * 17, whole);
    const chords: ChordSymbol[] = [];
    const numerals: string[] = [];
    path.forEach((k, i) => {
      const c = cands[k]!;
      const prev = i > 0 ? cands[path[i - 1]!] : undefined;
      // bỏ ký hiệu lặp lại liên tiếp trong cùng ô nhịp
      if (prev && prev.numeral === c.numeral && segs[i - 1]!.measureIndex === segs[i]!.measureIndex) return;
      const seg = segs[i]!;
      const degreePc: PitchClass = transposePitchClass(tonic, { diatonic: c.degree, chromatic: scale[c.degree]! });
      let root = c.rootAlter ? { ...degreePc, alter: degreePc.alter + c.rootAlter } : degreePc;
      if (c.resolvesTo !== undefined) {
        const target = transposePitchClass(tonic, { diatonic: c.resolvesTo, chromatic: scale[c.resolvesTo]! });
        root = transposePitchClass(target, { diatonic: 4, chromatic: 7 });
      }
      chords.push({ id: newId('ch'), partId: part.id, measureId: seg.measureId, offset: seg.offset, root, kind: c.kind });
      numerals.push(c.numeral);
    });
    const sig = chords.map((c) => `${c.measureId}:${c.offset}:${c.root.step}${c.root.alter}${c.kind}`).join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ id: `v${vi + 1}-${seed}`, label: cfg.label, description: cfg.description, chords, numerals, score: Math.round(sc * 100) / 100 });
    break;
    }
  });
  return out;
}

/** Áp dụng phương án: thay các hợp âm hiện có của bè trong phạm vi. Một bước Undo. */
export const applyHarmony = (variant: HarmonyVariant, partId: string, measureRange?: [number, number]): Command => ({
  label: `Áp dụng hợp âm (${variant.label})`,
  scope: () => ({ kind: 'all' }),
  apply: (s) => {
    const ids = new Set(
      (measureRange ? s.measures.slice(measureRange[0], measureRange[1] + 1) : s.measures).map((m) => m.id),
    );
    s.chordSymbols = s.chordSymbols
      .filter((c) => !(c.partId === partId && ids.has(c.measureId)))
      .concat(variant.chords.map((c) => ({ ...c, root: { ...c.root }, bass: c.bass ? { ...c.bass } : undefined })));
  },
});

/** Tên hợp âm dạng chữ (C, Dm, G7, F#m7♭5…) cho UI */
export function chordName(c: Pick<ChordSymbol, 'root' | 'kind' | 'bass'>): string {
  const pc = (p: PitchClass) => p.step + (p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter));
  const suffix: Record<ChordKind, string> = {
    major: '', minor: 'm', diminished: 'dim', augmented: 'aug', dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7',
    'half-diminished': 'm7b5', 'diminished-seventh': 'dim7', 'suspended-fourth': 'sus4', 'suspended-second': 'sus2',
    'major-sixth': '6', 'minor-sixth': 'm6', power: '5',
  };
  return pc(c.root) + suffix[c.kind] + (c.bass ? `/${pc(c.bass)}` : '');
}
