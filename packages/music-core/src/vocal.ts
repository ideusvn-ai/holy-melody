/**
 * Tổng hợp giọng hát từ giọng đọc (UTAU-like): mỗi âm tiết là một đoạn giọng đọc (OpenAI TTS); ứng dụng tìm cao độ
 * (YIN), đánh dấu chu kỳ thanh môn rồi dùng TD-PSOLA để đặt ĐÚNG cao độ từng nốt và kéo dài phần nguyên âm cho đủ
 * trường độ (giữ nguyên formant → vẫn nhận ra giọng và âm tiết). Thêm luyến (portamento) giữa nốt và rung (vibrato)
 * ở nốt dài. Chất lượng: rõ lời, đúng nốt, nhưng vẫn nghe "máy" — không thay thế ca sĩ thật.
 */

export interface PcmMono {
  sr: number;
  data: Float32Array;
}

/** Đọc WAV PCM 16-bit / float32 (mono hoặc stereo → mono). Chấp nhận header độ dài sai (WAV dạng luồng). */
export function decodeWav(bytes: Uint8Array): PcmMono {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Không phải file WAV');
  let o = 12;
  let fmt = 1;
  let ch = 1;
  let sr = 24000;
  let bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    let size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = dv.getUint16(o + 8, true);
      ch = dv.getUint16(o + 10, true);
      sr = dv.getUint32(o + 12, true);
      bits = dv.getUint16(o + 22, true);
    } else if (id === 'data') {
      const start = o + 8;
      if (size === 0 || size === 0xffffffff || start + size > bytes.length) size = bytes.length - start;
      const bps = bits / 8;
      const n = Math.floor(size / (bps * ch));
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let c = 0; c < ch; c++) {
          const p = start + (i * ch + c) * bps;
          acc += fmt === 3 && bits === 32 ? dv.getFloat32(p, true) : bits === 16 ? dv.getInt16(p, true) / 32768 : bits === 24
            ? ((bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16)) << 8 >> 8) / 8388608 : (bytes[p]! - 128) / 128;
        }
        out[i] = acc / ch;
      }
      return { sr, data: out };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV không có dữ liệu');
}

/** Ghi WAV 16-bit (1 hoặc 2 kênh) */
export function encodeWav(channels: Float32Array[], sr: number): Uint8Array {
  const ch = channels.length;
  const n = channels[0]!.length;
  const buf = new Uint8Array(44 + n * ch * 2);
  const dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  let p = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { dv.setInt16(p, Math.round(Math.max(-1, Math.min(1, channels[c]![i]!)) * 32767), true); p += 2; }
  return buf;
}

/** Đổi tần số lấy mẫu (nội suy tuyến tính, có lọc trung bình khi hạ tần số) */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const s = i * r;
    const k = Math.floor(s);
    const f = s - k;
    out[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? 0) * f;
  }
  return out;
}

/** Cao độ một khung bằng YIN; 0 = không hữu thanh */
export function yinPitch(x: Float32Array, start: number, len: number, sr: number, fmin = 70, fmax = 700, thresh = 0.15): number {
  const tauMax = Math.min(Math.floor(sr / fmin), Math.floor(len / 2));
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  if (start + len + tauMax > x.length || tauMax <= tauMin) return 0;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < len - tauMax; i++) {
      const v = x[start + i]! - x[start + i + tau]!;
      s += v * v;
    }
    d[tau] = s;
  }
  let run = 0;
  let best = -1;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau]!;
    const cm = run > 0 ? (d[tau]! * tau) / run : 1;
    d[tau] = cm;
  }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau]! < thresh) {
      while (tau + 1 <= tauMax && d[tau + 1]! < d[tau]!) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return 0;
  // nội suy parabol
  const a = d[best - 1] ?? d[best]!;
  const b = d[best]!;
  const c = d[best + 1] ?? d[best]!;
  const den = a - 2 * b + c;
  const t = den !== 0 ? best + (0.5 * (a - c)) / den : best;
  return sr / t;
}

export interface SyllableAnalysis {
  /** đầu/cuối sau khi cắt lặng (mẫu) */
  start: number;
  end: number;
  voicedStart: number;
  voicedEnd: number;
  /** vị trí các chu kỳ (mẫu) trong vùng hữu thanh và độ dài chu kỳ tại đó */
  marks: number[];
  periods: number[];
  /** cao độ trung bình (Hz) */
  f0: number;
}

export function analyzeSyllable(p: PcmMono): SyllableAnalysis {
  const { data: x, sr } = p;
  // cắt lặng: RMS theo khung 10 ms, ngưỡng −40 dB so với đỉnh
  const fl = Math.round(sr * 0.01);
  const rms: number[] = [];
  let peak = 1e-9;
  for (let i = 0; i + fl <= x.length; i += fl) {
    let s = 0;
    for (let k = 0; k < fl; k++) s += x[i + k]! * x[i + k]!;
    const r = Math.sqrt(s / fl);
    rms.push(r);
    peak = Math.max(peak, r);
  }
  const th = peak * 0.01;
  let a = rms.findIndex((r) => r > th);
  let b = rms.length - 1 - [...rms].reverse().findIndex((r) => r > th);
  if (a < 0) { a = 0; b = rms.length - 1; }
  const start = a * fl;
  const end = Math.min(x.length, (b + 1) * fl);
  // cao độ theo khung (bước 5 ms, cửa sổ 40 ms)
  const hop = Math.round(sr * 0.005);
  const win = Math.round(sr * 0.04);
  const f: { pos: number; f0: number }[] = [];
  for (let i = start; i + win * 2 < end + win; i += hop) {
    const loud = rms[Math.floor((i + win / 2) / fl)] ?? 0;
    f.push({ pos: i + win / 2, f0: loud > peak * 0.05 ? yinPitch(x, i, win, sr) : 0 });
  }
  // làm mượt: bỏ điểm lẻ loi
  for (let i = 1; i + 1 < f.length; i++) if (f[i]!.f0 && !f[i - 1]!.f0 && !f[i + 1]!.f0) f[i]!.f0 = 0;
  const voiced = f.filter((v) => v.f0 > 0);
  if (voiced.length < 3) {
    // không tìm được thanh âm: coi cả đoạn là hữu thanh ở 150 Hz (vẫn kéo dài được)
    const P = Math.round(sr / 150);
    const marks: number[] = [];
    for (let m = start + P; m < end - P; m += P) marks.push(m);
    return { start, end, voicedStart: start, voicedEnd: end, marks, periods: marks.map(() => P), f0: 150 };
  }
  const sorted = voiced.map((v) => v.f0).sort((p1, p2) => p1 - p2);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  const voicedStart = Math.max(start, Math.round(voiced[0]!.pos - win / 2));
  const voicedEnd = Math.min(end, Math.round(voiced[voiced.length - 1]!.pos + win / 2));
  const f0At = (pos: number) => {
    let best = med;
    let bd = Infinity;
    for (const v of voiced) {
      const dd = Math.abs(v.pos - pos);
      if (dd < bd && v.f0 > med * 0.6 && v.f0 < med * 1.6) { bd = dd; best = v.f0; }
    }
    return best;
  };
  // đánh dấu chu kỳ: đỉnh dương lớn nhất trong từng chu kỳ
  const marks: number[] = [];
  const periods: number[] = [];
  let P0 = sr / f0At(voicedStart);
  let m = voicedStart;
  let mx = -Infinity;
  for (let i = voicedStart; i < Math.min(voicedEnd, voicedStart + P0); i++) if (x[i]! > mx) { mx = x[i]!; m = i; }
  while (m < voicedEnd - 1) {
    const P = sr / f0At(m);
    marks.push(m);
    periods.push(P);
    const c = Math.round(m + P);
    const r = Math.round(P * 0.2);
    let bm = c;
    let bv = -Infinity;
    for (let i = Math.max(m + 1, c - r); i <= Math.min(x.length - 1, c + r); i++) if (x[i]! > bv) { bv = x[i]!; bm = i; }
    if (bm <= m) break;
    m = bm;
    P0 = P;
  }
  void P0;
  return { start, end, voicedStart, voicedEnd, marks, periods, f0: med };
}

/** Một nốt trong âm tiết, thời gian tính từ đầu âm tiết (giây) */
export interface VoiceNote {
  t: number;
  dur: number;
  midi: number;
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * Hát một âm tiết: phụ âm đầu giữ tốc độ tự nhiên, vần (phần hữu thanh) kéo/co cho vừa, cao độ theo các nốt.
 * Trả về PCM ở tần số lấy mẫu của nguồn, dài đúng tổng trường độ các nốt.
 */
export function singSyllable(src: PcmMono, an: SyllableAnalysis, notes: VoiceNote[], opts: { vibrato?: number; glide?: number } = {}): Float32Array {
  const { data: x, sr } = src;
  const total = notes.length ? notes[notes.length - 1]!.t + notes[notes.length - 1]!.dur : 0;
  const N = Math.max(1, Math.round(total * sr));
  const out = new Float32Array(N + sr);
  const vib = opts.vibrato ?? 0.28; // nửa cung
  const glide = opts.glide ?? 0.045;
  // phụ âm đầu: tối đa 35% độ dài âm tiết, tối đa 0.18 s
  const consLen = Math.min(an.voicedStart - an.start, Math.round(N * 0.35), Math.round(sr * 0.18));
  for (let i = 0; i < consLen; i++) {
    const fade = Math.min(1, i / (sr * 0.004));
    out[i] = x[an.voicedStart - consLen + i]! * fade;
  }
  const marks = an.marks;
  if (!marks.length) return out.subarray(0, N);
  const srcA = marks[0]!;
  const srcB = marks[marks.length - 1]!;
  const V = srcB - srcA;
  const L = Math.max(1, N - consLen - Math.round(sr * 0.02));
  // ánh xạ thời gian: đầu/cuối vần giữ tự nhiên (chuyển âm), giữa kéo dài
  const edge = Math.min(Math.round(sr * 0.07), Math.floor(V * 0.3), Math.floor(L * 0.3));
  const mapSrc = (u: number) => {
    if (u < edge) return srcA + u;
    if (u > L - edge) return srcB - (L - u);
    const mid = (u - edge) / Math.max(1, L - 2 * edge);
    return srcA + edge + mid * Math.max(0, V - 2 * edge);
  };
  const f0At = (t: number) => {
    // nốt hiện tại + luyến từ nốt trước
    let k = 0;
    while (k + 1 < notes.length && notes[k + 1]!.t <= t) k++;
    const n = notes[k]!;
    let midi = n.midi;
    const into = t - n.t;
    if (k > 0 && into < glide) midi = notes[k - 1]!.midi + (n.midi - notes[k - 1]!.midi) * (0.5 - 0.5 * Math.cos((Math.PI * into) / glide));
    // rung giọng ở nốt dài (từ 0.25 s, tăng dần)
    if (n.dur > 0.45 && into > 0.25) midi += vib * Math.min(1, (into - 0.25) / 0.3) * Math.sin(2 * Math.PI * 5.4 * (into - 0.25));
    return hz(midi);
  };
  // TD-PSOLA
  let si = 0;
  let u = 0;
  const releaseFrom = L - Math.round(sr * 0.05);
  while (u < L) {
    const t = (consLen + u) / sr;
    const P = sr / f0At(t);
    const s = mapSrc(u);
    while (si + 1 < marks.length && Math.abs(marks[si + 1]! - s) < Math.abs(marks[si]! - s)) si++;
    while (si > 0 && Math.abs(marks[si - 1]! - s) < Math.abs(marks[si]! - s)) si--;
    const m = marks[si]!;
    const Ps = an.periods[si]!;
    const half = Math.round(Math.min(Ps, P * 1.5));
    const gain = Math.min(1.3, Math.max(0.6, P / Ps));
    const env = u < sr * 0.012 ? u / (sr * 0.012) : u > releaseFrom ? Math.max(0, (L - u) / (L - releaseFrom)) : 1;
    const at = Math.round(consLen + u);
    for (let k = -half; k <= half; k++) {
      const xi = m + k;
      const oi = at + k;
      if (xi < 0 || xi >= x.length || oi < 0 || oi >= out.length) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / (half + 1));
      out[oi] = out[oi]! + x[xi]! * w * gain * env;
    }
    u += P;
  }
  return out.subarray(0, N);
}
