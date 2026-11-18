/**
 * AI Singer: dựng bài hát có lời từ bản nhạc.
 *  1. kế hoạch hát (music-core singerPlan): âm tiết + các nốt của nó (giây);
 *  2. máy chủ đọc từng âm tiết bằng OpenAI TTS (giọng đã chọn, lưu đệm) → WAV;
 *  3. ứng dụng tìm cao độ + chu kỳ thanh môn, TD-PSOLA đặt đúng cao độ/trường độ từng nốt, luyến, rung giọng;
 *  4. trộn với đệm đàn (engine SoundFont, có dạo đầu) → WAV stereo 44.1 kHz.
 */
import {
  accompany, analyzeSyllable, buildTimeline, chordsForAccompaniment, decodeWav, DEFAULT_PLAYER_SETTINGS, encodeWav, resample, singerPlan,
  singSyllable, tickToSeconds, type PcmMono, type ScoreDocument, type SingPlan, type SyllableAnalysis,
} from '@holy-melody/music-core';
import { tauriInvoke } from './fileio';

export const SINGER_VOICES = [
  { id: 'coral', label: 'Nữ ấm (coral)' },
  { id: 'shimmer', label: 'Nữ cao (shimmer)' },
  { id: 'nova', label: 'Nữ trẻ (nova)' },
  { id: 'sage', label: 'Nữ trầm (sage)' },
  { id: 'ash', label: 'Nam (ash)' },
  { id: 'echo', label: 'Nam trẻ (echo)' },
  { id: 'onyx', label: 'Nam trầm (onyx)' },
  { id: 'ballad', label: 'Nam mềm (ballad)' },
] as const;

export type SingerMode = 'solo' | 'duet' | 'choir';
export type Accomp = 'none' | 'chords' | 'full';

export interface SingerOptions {
  mode: SingerMode;
  partId: string;
  verse: number;
  voice: string;
  style: string;
  accompaniment: Accomp;
  transpose: number;
  /** chỉ hát N âm tiết đầu (nghe thử) */
  previewSyllables?: number;
}

export interface VoiceApi {
  (body: { syllables: string[]; voice: string; style: string }, idempotencyKey: string): Promise<{ items: Record<string, string>; missing: string[]; credits: number }>;
}

export interface SingerProgress { text: string; done: number; total: number }

/** Các bè sẽ hát và giọng của từng bè */
export function voiceAssignments(score: ScoreDocument, o: Pick<SingerOptions, 'mode' | 'partId' | 'voice'>): { partId: string; voice: string; name: string }[] {
  if (o.mode === 'solo') return [{ partId: o.partId, voice: o.voice, name: score.parts.find((p) => p.id === o.partId)?.name ?? '' }];
  const byName = (name: string, i: number) => {
    const n = name.toLowerCase();
    if (/sop|^s\b|nữ cao/.test(n)) return 'shimmer';
    if (/alt|^a\b|nữ trầm/.test(n)) return 'sage';
    if (/ten|^t\b|nam cao/.test(n)) return 'ash';
    if (/bas|^b\b|nam trầm/.test(n)) return 'onyx';
    return ['shimmer', 'sage', 'ash', 'onyx'][i % 4]!;
  };
  const parts = score.parts.slice(0, o.mode === 'duet' ? 2 : 4);
  if (o.mode === 'duet' && parts.length === 1) return [{ partId: parts[0]!.id, voice: 'coral', name: 'Nữ' }, { partId: parts[0]!.id, voice: 'ash', name: 'Nam' }];
  return parts.map((p, i) => ({ partId: p.id, voice: o.mode === 'duet' ? (i === 0 ? 'coral' : 'ash') : byName(p.name, i), name: p.name }));
}

/** Bè giai điệu có lời (để các bè không lời mượn) */
export function lyricPartOf(score: ScoreDocument, preferred: string): string {
  const has = (id: string) => {
    const p = score.parts.find((x) => x.id === id);
    return !!p && Object.values(p.content).some((vs) => vs.some((v) => v.events.some((e) => e.kind === 'chord' && e.lyrics.length)));
  };
  if (has(preferred)) return preferred;
  return score.parts.find((p) => has(p.id))?.id ?? preferred;
}

export function plansFor(score: ScoreDocument, o: SingerOptions): { voice: string; partId: string; name: string; plan: SingPlan }[] {
  const lyricPart = lyricPartOf(score, o.partId);
  return voiceAssignments(score, o).map((a) => {
    const plan = singerPlan(score, { partId: a.partId, verse: o.verse, borrowFromPartId: lyricPart, transpose: o.transpose });
    if (o.previewSyllables) plan.syllables = plan.syllables.slice(0, o.previewSyllables);
    return { ...a, plan };
  });
}

function rms(x: Float32Array): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== 0) { s += x[i]! * x[i]!; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

/** WAV 16-bit stereo do engine SoundFont xuất → [trái, phải] */
function decodeStereo(bytes: Uint8Array): { sr: number; l: Float32Array; r: Float32Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sr = dv.getUint32(24, true);
  const ch = dv.getUint16(22, true);
  let o = 12;
  while (o + 8 < bytes.length && String.fromCharCode(...bytes.subarray(o, o + 4)) !== 'data') o += 8 + dv.getUint32(o + 4, true);
  const start = o + 8;
  const n = Math.floor((bytes.length - start) / (2 * ch));
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = dv.getInt16(start + i * ch * 2, true) / 32768;
    r[i] = ch > 1 ? dv.getInt16(start + i * ch * 2 + 2, true) / 32768 : l[i]!;
  }
  return { sr, l, r };
}

/** Đệm đàn bằng engine SoundFont (Rust): trả về PCM stereo 44.1 kHz và độ trễ (giây) trước nốt hát đầu tiên */
async function renderAccompaniment(score: ScoreDocument, o: SingerOptions): Promise<{ l: Float32Array; r: Float32Array; offset: number } | null> {
  const invoke = tauriInvoke();
  if (!invoke || o.accompaniment === 'none') return null;
  if ((await invoke('playback_engine_available')) !== true) throw new Error('Engine SoundFont chưa sẵn sàng nên chưa dựng được phần đệm.');
  const base = buildTimeline(score);
  const tl = accompany(score, base, { ...DEFAULT_PLAYER_SETTINGS, program: 0, transpose: o.transpose, countIn: false, intro: true, melodyVolume: 0.55, chordVolume: 0.7 }, chordsForAccompaniment(score));
  const pre = tl.preroll.introTicks;
  const notes = o.accompaniment === 'full' ? tl.notes : tl.notes.filter((n) => n.partId === '__acc' || n.tick < pre);
  const path = (await invoke('omr_temp_input', { name: 'singer-accompaniment.wav' })) as string;
  await invoke('export_wav', {
    path,
    args: {
      ticksPerQuarter: tl.ticksPerQuarter, totalTicks: tl.totalTicks, tempo: tl.tempo, beats: [],
      notes: notes.map((n) => ({ tick: n.tick, durationTicks: n.durationTicks, channel: n.channel, program: n.program, pitch: n.pitch, velocity: n.velocity })),
    },
    mixer: [],
  });
  const wav = decodeStereo(new Uint8Array((await invoke('read_file', { path })) as ArrayBuffer));
  return { l: resample(wav.l, wav.sr, 44100), r: resample(wav.r, wav.sr, 44100), offset: tickToSeconds(tl, pre) };
}

const analysisCache = new Map<string, { pcm: PcmMono; an: SyllableAnalysis }>();

export async function renderSong(score: ScoreDocument, o: SingerOptions, api: VoiceApi, idem: (voice: string) => string, onProgress: (p: SingerProgress) => void): Promise<{ wav: Uint8Array; seconds: number; missing: string[]; credits: number }> {
  const plans = plansFor(score, o).filter((p) => p.plan.syllables.length);
  if (!plans.length) throw new Error('Không có nốt nào có lời để hát. Hãy nhập lời ca trong Score Editor (bảng "Lời ca").');
  const missing = new Set<string>();
  let credits = 0;
  // 1. giọng đọc từng âm tiết (máy chủ, mỗi giọng một lần gọi)
  const voices = [...new Set(plans.map((p) => p.voice))];
  for (const [i, voice] of voices.entries()) {
    const keys = [...new Set(plans.filter((p) => p.voice === voice).flatMap((p) => p.plan.syllables.map((s) => s.key)))]
      .filter((k) => !analysisCache.has(`${voice}|${o.style}|${k}`));
    if (!keys.length) continue;
    onProgress({ text: `Tạo giọng ${voice}: ${keys.length} âm tiết…`, done: i, total: voices.length + 2 });
    const res = await api({ syllables: keys, voice, style: o.style }, idem(voice));
    credits += res.credits;
    for (const [k, b64] of Object.entries(res.items)) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      try {
        const pcm = decodeWav(bytes);
        analysisCache.set(`${voice}|${o.style}|${k}`, { pcm, an: analyzeSyllable(pcm) });
      } catch {
        missing.add(k);
      }
    }
    res.missing.forEach((k) => missing.add(k));
  }
  // 2. hát từng âm tiết
  onProgress({ text: 'Đặt cao độ, trường độ từng nốt…', done: voices.length, total: voices.length + 2 });
  const end = Math.max(...plans.map((p) => p.plan.duration)) + 1.5;
  const SR = 44100;
  const tracks: { l: Float32Array; r: Float32Array } = { l: new Float32Array(Math.ceil(end * SR)), r: new Float32Array(Math.ceil(end * SR)) };
  const pans = plans.length === 1 ? [0] : plans.map((_, i) => (i / (plans.length - 1) - 0.5) * 0.5);
  for (const [pi, p] of plans.entries()) {
    const sr0 = [...analysisCache.values()][0]?.pcm.sr ?? 24000;
    const track = new Float32Array(Math.ceil(end * sr0));
    p.plan.syllables.forEach((s, si) => {
      const hit = analysisCache.get(`${p.voice}|${o.style}|${s.key}`);
      if (!hit) return;
      const t0 = s.notes[0]!.start;
      const next = p.plan.syllables[si + 1];
      const lastEnd = s.notes[s.notes.length - 1]!.start + s.notes[s.notes.length - 1]!.dur;
      // ngắt rất ngắn giữa hai âm tiết liền nhau để lời rõ
      const gap = next && Math.abs(next.notes[0]!.start - lastEnd) < 0.01 ? Math.min(0.04, s.notes[s.notes.length - 1]!.dur * 0.15) : 0;
      const notes = s.notes.map((n, k) => ({ t: n.start - t0, dur: n.dur - (k === s.notes.length - 1 ? gap : 0), midi: n.midi }));
      let pcm = singSyllable(hit.pcm, hit.an, notes);
      if (hit.pcm.sr !== sr0) pcm = resample(pcm, hit.pcm.sr, sr0);
      const g = 0.16 / Math.max(1e-4, rms(pcm));
      const at = Math.round(t0 * sr0);
      for (let k = 0; k < pcm.length && at + k < track.length; k++) track[at + k] = track[at + k]! + pcm[k]! * g;
    });
    const up = resample(track, sr0, SR);
    const gain = 1 / Math.sqrt(plans.length);
    const pan = pans[pi]!;
    for (let k = 0; k < up.length && k < tracks.l.length; k++) {
      tracks.l[k] = tracks.l[k]! + up[k]! * gain * (1 - pan);
      tracks.r[k] = tracks.r[k]! + up[k]! * gain * (1 + pan);
    }
  }
  // 3. đệm đàn
  onProgress({ text: 'Dựng phần đệm đàn…', done: voices.length + 1, total: voices.length + 2 });
  let L = tracks.l;
  let R = tracks.r;
  const acc = o.previewSyllables ? null : await renderAccompaniment(score, o);
  if (acc) {
    const off = Math.round(acc.offset * SR);
    const n = Math.max(acc.l.length, off + L.length);
    const l2 = new Float32Array(n);
    const r2 = new Float32Array(n);
    for (let k = 0; k < acc.l.length; k++) { l2[k] = acc.l[k]! * 0.75; r2[k] = acc.r[k]! * 0.75; }
    for (let k = 0; k < L.length; k++) { l2[off + k] = l2[off + k]! + L[k]!; r2[off + k] = r2[off + k]! + R[k]!; }
    L = l2;
    R = r2;
  }
  // chuẩn hoá đỉnh −1 dBFS
  let peak = 1e-6;
  for (let k = 0; k < L.length; k++) peak = Math.max(peak, Math.abs(L[k]!), Math.abs(R[k]!));
  const norm = 0.89 / peak;
  for (let k = 0; k < L.length; k++) { L[k] = L[k]! * norm; R[k] = R[k]! * norm; }
  return { wav: encodeWav([L, R], SR), seconds: L.length / SR, missing: [...missing], credits };
}
