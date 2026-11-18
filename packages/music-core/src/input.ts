/**
 * Nhập nốt thông minh (kiểu MuseScore): đặt một nốt tại thời điểm bất kỳ trong ô nhịp, GHI ĐÈ lên dấu lặng/nốt
 * đang chiếm khoảng thời gian đó. Phần thừa được bù bằng dấu lặng; nốt bị cắt ngang được rút ngắn (nối dây nếu
 * cần nhiều trường độ). Ô nhịp luôn đủ phách sau khi nhập.
 */
import { durationTicks } from './duration.js';
import type { Command } from './history.js';
import { newId } from './ids.js';
import type { ChordEvent, Duration, DurationType, MusicEvent, Pitch, ScoreDocument, Voice } from './model.js';
import { chord, fillRests, keyAt, measureTicks, note } from './score.js';

const PIECES: [DurationType, number, number][] = [
  ['whole', 0, 1920], ['half', 1, 1440], ['half', 0, 960], ['quarter', 1, 720], ['quarter', 0, 480],
  ['eighth', 1, 360], ['eighth', 0, 240], ['16th', 1, 180], ['16th', 0, 120], ['32nd', 0, 60],
];

/** Chia một khoảng tick thành các trường độ chuẩn (có chấm) */
export function splitTicks(ticks: number): Duration[] {
  const out: Duration[] = [];
  let t = ticks;
  for (const [type, dots, v] of PIECES) while (t >= v) { out.push({ type, dots }); t -= v; }
  return out;
}

export interface PlaceNoteOptions {
  partId: string;
  measureIndex: number;
  voice: number;
  staff: number;
  /** tick trong ô nhịp */
  tick: number;
  pitch: Pitch;
  duration: Duration;
  /** Thêm vào hợp âm đang có tại đúng thời điểm đó thay vì ghi đè */
  addToChord?: boolean;
}

interface Placed { ev: MusicEvent; start: number; len: number }

function timeline(v: Voice, total: number): Placed[] {
  let t = 0;
  return v.events.map((ev) => {
    const len = ev.kind === 'chord' && ev.grace ? 0 : ev.kind === 'rest' && ev.measureRest ? total : durationTicks(ev.duration);
    const p = { ev, start: t, len };
    t += len;
    return p;
  });
}

/** Lệnh đặt nốt. Trả về id nốt mới qua `result.noteId` sau khi apply (để chọn & đi tiếp). */
export function placeNote(o: PlaceNoteOptions): Command & { result: { noteId?: string; eventId?: string } } {
  const result: { noteId?: string; eventId?: string } = {};
  return {
    label: 'Đặt nốt',
    result,
    scope: () => ({ kind: 'all' }),
    apply: (s: ScoreDocument) => {
      const part = s.parts.find((p) => p.id === o.partId);
      const m = s.measures[o.measureIndex];
      if (!part || !m) return;
      const total = measureTicks(s, o.measureIndex);
      let voices = part.content[m.id];
      if (!voices) part.content[m.id] = voices = [];
      let v = voices.find((x) => x.number === o.voice);
      if (!v) {
        v = { id: newId('v'), number: o.voice, events: fillRests(total, o.staff) };
        voices.push(v);
      }
      const placed = timeline(v, total);
      const tick = Math.max(0, Math.min(o.tick, total - 60));

      // thêm vào hợp âm có sẵn đúng thời điểm
      if (o.addToChord) {
        const at = placed.find((p) => p.start === tick && p.ev.kind === 'chord' && !(p.ev as ChordEvent).grace);
        if (at && at.ev.kind === 'chord') {
          const n = note(o.pitch);
          if (!at.ev.notes.some((x) => x.pitch.step === o.pitch.step && x.pitch.octave === o.pitch.octave && x.pitch.alter === o.pitch.alter)) at.ev.notes.push(n);
          result.noteId = n.id;
          result.eventId = at.ev.id;
          s.revision++;
          return;
        }
      }

      // nốt trong liên ba: chỉ thay đúng phần tử đó (không cắt nhóm liên âm)
      const hit = placed.find((p) => p.start <= tick && tick < p.start + p.len);
      if (hit && hit.ev.duration.tuplet) {
        const c = chord([o.pitch], hit.ev.duration, { staff: hit.ev.staff });
        v.events[v.events.indexOf(hit.ev)] = c;
        result.noteId = c.notes[0]!.id;
        result.eventId = c.id;
        s.revision++;
        return;
      }

      const len = Math.min(durationTicks(o.duration), total - tick);
      const end = tick + len;
      const out: MusicEvent[] = [];
      for (const p of placed) {
        const pEnd = p.start + p.len;
        if (p.len === 0) {
          // nốt hoa mỹ: giữ nếu không nằm trong vùng ghi đè
          if (p.start < tick || p.start >= end) out.push(p.ev);
          continue;
        }
        if (pEnd <= tick || p.start >= end) {
          out.push(p.ev);
          continue;
        }
        // phần trước vùng ghi đè
        if (p.start < tick) out.push(...truncate(p.ev, tick - p.start));
        if (p.start <= tick && tick < pEnd) {
          const pieces = splitTicks(len);
          pieces.forEach((d, i) => {
            const c = chord([o.pitch], d, { staff: o.staff });
            if (i < pieces.length - 1) c.notes[0]!.tieStart = true;
            if (i > 0) c.notes[0]!.tieStop = true;
            if (i === 0) {
              result.noteId = c.notes[0]!.id;
              result.eventId = c.id;
            }
            out.push(c);
          });
        }
        // phần sau vùng ghi đè → dấu lặng
        if (pEnd > end) out.push(...fillRests(pEnd - Math.max(end, p.start), p.ev.staff).map((r) => ({ ...r, id: newId('e') })));
      }
      v.events = out;
      s.revision++;
    },
  };
}

/** Rút ngắn một sự kiện còn `ticks` (nốt: chia trường độ + nối dây; lặng: chia trường độ) */
function truncate(ev: MusicEvent, ticks: number): MusicEvent[] {
  const pieces = splitTicks(ticks);
  if (ev.kind !== 'chord') return pieces.map((d) => ({ id: newId('e'), kind: 'rest' as const, duration: d, staff: ev.staff }));
  return pieces.map((d, i) => {
    const c: ChordEvent = {
      ...ev,
      id: i === 0 ? ev.id : newId('e'),
      duration: d,
      lyrics: i === 0 ? ev.lyrics : [],
      notes: ev.notes.map((n) => ({
        ...n,
        id: i === 0 ? n.id : newId('n'),
        tieStart: i < pieces.length - 1 ? true : undefined, // phần sau đã bị ghi đè
        tieStop: i > 0 ? true : n.tieStop,
      })),
    };
    return c;
  });
}

/** Cao độ từ vị trí trên khuông: `steps` = số bậc (nửa khoảng) tính từ dòng kẻ dưới cùng, có hoá biểu */
export function pitchFromStaffStep(clef: { sign: string; line: number; octaveChange?: number }, steps: number, keyFifths: number): Pitch {
  // bậc của dòng dưới cùng: khoá Sol E4, khoá Fa G2, khoá Đô (dòng 3) F3
  const bottom: Record<string, [number, number]> = { G: [2, 4], F: [4, 2], C: [3, 3] }; // [chỉ số bậc trong CDEFGAB, quãng tám]
  const [si, oct] = clef.sign === 'C' && clef.line === 4 ? [1, 3] : bottom[clef.sign] ?? bottom.G!;
  const abs = si + oct * 7 + steps + (clef.octaveChange ?? 0) * 7;
  const step = 'CDEFGAB'[((abs % 7) + 7) % 7] as Pitch['step'];
  const octave = Math.floor(abs / 7);
  const sharps = 'FCGDAEB'.slice(0, Math.max(0, keyFifths));
  const flats = 'BEADGCF'.slice(0, Math.max(0, -keyFifths));
  const alter = sharps.includes(step) ? 1 : flats.includes(step) ? -1 : 0;
  return { step, octave, alter };
}

/** Hoá biểu đang có hiệu lực tại ô nhịp (tiện cho UI) */
export const keyFifthsAt = (s: ScoreDocument, mi: number) => keyAt(s, mi).fifths;
