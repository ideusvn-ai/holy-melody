/**
 * Lệnh ký âm cho Score Editor. Mọi lệnh là Command → có Undo/Redo, đồng bộ sang Player và AI Singer.
 */
import { durationTicks, DURATION_TYPES } from './duration.js';
import type { Command, Scope } from './history.js';
import { newId } from './ids.js';
import type {
  Articulation, Barline, ChordEvent, DurationType, DynamicMark, MusicEvent, Ornament, Pitch, ScoreDocument, Voice,
} from './model.js';
import { keyAlterFor, pitchToMidi, STEPS } from './pitch.js';
import { eventTicksIn, keyAt, ScoreIndex } from './score.js';

const ALL: Scope = { kind: 'all' };

class NotationError extends Error {}

function chordOf(s: ScoreDocument, eventId: string) {
  const loc = new ScoreIndex(s).event(eventId);
  if (!loc) throw new NotationError('Không tìm thấy nốt');
  if (loc.event.kind !== 'chord') throw new NotationError('Thao tác này cần chọn nốt, không phải dấu lặng');
  return { ...loc, event: loc.event as ChordEvent };
}

const cell = (s: ScoreDocument, eventId: string): Scope => {
  const loc = new ScoreIndex(s).event(eventId);
  if (!loc) throw new NotationError('Không tìm thấy nốt');
  return { kind: 'cells', cells: [{ partId: loc.part.id, measureId: loc.measure.id }] };
};

/** Dãy event của một voice xuyên suốt các ô nhịp */
function voiceSequence(s: ScoreDocument, partId: string, voiceNumber: number) {
  const part = s.parts.find((p) => p.id === partId)!;
  const out: { measureIndex: number; voice: Voice; index: number; event: MusicEvent }[] = [];
  s.measures.forEach((m, mi) => {
    const v = (part.content[m.id] ?? []).find((x) => x.number === voiceNumber);
    v?.events.forEach((event, index) => out.push({ measureIndex: mi, voice: v, index, event }));
  });
  return out;
}

/** Nốt cao/thấp hơn n bậc trong giọng (theo hóa biểu) */
function diatonicAbove(s: ScoreDocument, measureIndex: number, p: Pitch, steps: number): Pitch {
  const idx = p.octave * 7 + STEPS.indexOf(p.step) + steps;
  const step = STEPS[((idx % 7) + 7) % 7]!;
  return { step, alter: keyAlterFor(step, keyAt(s, measureIndex).fifths), octave: Math.floor(idx / 7) };
}

// ====================================================================== nối & luyến

/** Bật/tắt dấu nối từ nốt này sang nốt cùng cao độ kế tiếp (kể cả qua vạch nhịp) */
export const toggleTie = (noteId: string): Command => ({
  label: 'Dấu nối',
  scope: () => ALL,
  apply: (s) => {
    const loc = new ScoreIndex(s).note(noteId);
    if (!loc) throw new NotationError('Không tìm thấy nốt');
    const seq = voiceSequence(s, loc.part.id, loc.voice.number);
    const i = seq.findIndex((x) => x.event.id === loc.event.id);
    const next = seq.slice(i + 1).find((x) => !(x.event.kind === 'chord' && x.event.grace));
    const midi = pitchToMidi(loc.note.pitch);
    const target = next?.event.kind === 'chord' ? next.event.notes.find((n) => pitchToMidi(n.pitch) === midi) : undefined;
    if (loc.note.tieStart) {
      loc.note.tieStart = undefined;
      if (target) target.tieStop = undefined;
      return;
    }
    if (!target) throw new NotationError('Dấu nối cần nốt kế tiếp cùng cao độ');
    loc.note.tieStart = true;
    target.tieStop = true;
  },
});

/** Bật/tắt dấu luyến giữa event đầu và event cuối được chọn (một event: luyến tới event kế tiếp) */
export const toggleSlur = (eventIds: string[]): Command => ({
  label: 'Dấu luyến',
  scope: () => ALL,
  apply: (s) => {
    const idx = new ScoreIndex(s);
    const locs = eventIds.map((id) => idx.event(id)).filter((x): x is NonNullable<typeof x> => !!x);
    if (!locs.length) throw new NotationError('Hãy chọn nốt');
    const first = locs[0]!;
    const seq = voiceSequence(s, first.part.id, first.voice.number).filter((x) => x.event.kind === 'chord');
    const pos = (id: string) => seq.findIndex((x) => x.event.id === id);
    const sorted = locs.filter((l) => l.part.id === first.part.id && l.voice.number === first.voice.number).map((l) => pos(l.event.id)).filter((p) => p >= 0).sort((a, b) => a - b);
    if (!sorted.length) throw new NotationError('Dấu luyến chỉ nối các nốt (không phải dấu lặng)');
    const a = seq[sorted[0]!]!.event as ChordEvent;
    const bIndex = sorted.length > 1 ? sorted[sorted.length - 1]! : sorted[0]! + 1;
    const b = seq[bIndex]?.event as ChordEvent | undefined;
    if (!b || b === a) throw new NotationError('Cần ít nhất hai nốt để luyến');
    if (a.slurStart && b.slurStop) {
      a.slurStart = undefined;
      b.slurStop = undefined;
    } else {
      a.slurStart = true;
      b.slurStop = true;
    }
  },
});

// ====================================================================== liên 3 (tuplet)

/**
 * Biến nốt/dấu lặng thành nhóm liên (mặc định liên 3: ba nốt trong thời gian của hai).
 * Nốt đầu giữ cao độ, các nốt sau là dấu lặng để người dùng nhập tiếp.
 */
export const makeTuplet = (eventId: string, actual = 3): Command => ({
  label: `Liên ${actual}`,
  scope: (s) => cell(s, eventId),
  apply: (s) => {
    const loc = new ScoreIndex(s).event(eventId);
    if (!loc) throw new NotationError('Không tìm thấy nốt');
    const ev = loc.event;
    if (ev.duration.tuplet) throw new NotationError('Nốt này đã nằm trong nhóm liên');
    if (ev.duration.dots) throw new NotationError('Hãy bỏ chấm dôi trước khi tạo nhóm liên');
    if (ev.kind === 'rest' && ev.measureRest) throw new NotationError('Hãy chọn trường độ cụ thể trước');
    if (![3, 5, 6, 7].includes(actual)) throw new NotationError('Hỗ trợ liên 3, 5, 6, 7');
    const normal = actual === 3 ? 2 : 4;
    const ti = DURATION_TYPES.indexOf(ev.duration.type) + Math.log2(normal);
    const type = DURATION_TYPES[ti] as DurationType | undefined;
    if (!type) throw new NotationError('Trường độ quá ngắn để chia nhóm liên');
    const tuplet = { actual, normal };
    const parts: MusicEvent[] = [];
    for (let k = 0; k < actual; k++) {
      if (k === 0 && ev.kind === 'chord') {
        parts.push({ ...ev, duration: { type, dots: 0, tuplet } });
      } else {
        parts.push({ kind: 'rest', id: k === 0 ? ev.id : newId('e'), duration: { type, dots: 0, tuplet }, staff: ev.staff });
      }
    }
    const total = parts.reduce((a, e) => a + durationTicks(e.duration), 0);
    if (Math.abs(total - durationTicks(ev.duration)) > actual) throw new NotationError('Không chia được nhóm liên cho trường độ này');
    loc.voice.events.splice(loc.eventIndex, 1, ...parts);
  },
});

// ====================================================================== hợp âm trên khuông

/** Thêm một nốt cách nốt cao nhất n quãng (3 = quãng 3) theo giọng */
export const addInterval = (eventId: string, intervalNumber: number): Command => ({
  label: `Thêm quãng ${intervalNumber}`,
  scope: (s) => cell(s, eventId),
  apply: (s) => {
    const { event, measureIndex } = chordOf(s, eventId);
    const top = event.notes.reduce((a, b) => (pitchToMidi(b.pitch) > pitchToMidi(a.pitch) ? b : a));
    const p = diatonicAbove(s, measureIndex, top.pitch, intervalNumber - 1);
    if (event.notes.some((n) => pitchToMidi(n.pitch) === pitchToMidi(p))) return;
    event.notes.push({ id: newId('n'), pitch: p });
  },
});

/** Dựng hợp âm ba (gốc – quãng 3 – quãng 5 theo giọng) trên nốt thấp nhất */
export const addTriad = (eventId: string, inversion: 0 | 1 | 2 = 0): Command => ({
  label: 'Hợp âm ba',
  scope: (s) => cell(s, eventId),
  apply: (s) => {
    const { event, measureIndex } = chordOf(s, eventId);
    const root = event.notes.reduce((a, b) => (pitchToMidi(b.pitch) < pitchToMidi(a.pitch) ? b : a));
    const third = diatonicAbove(s, measureIndex, root.pitch, 2);
    const fifth = diatonicAbove(s, measureIndex, root.pitch, 4);
    const tones = [root.pitch, third, fifth];
    for (let k = 0; k < inversion; k++) {
      const low = tones.shift()!;
      tones.push({ ...low, octave: low.octave + 1 });
    }
    const keep = event.notes.find((n) => pitchToMidi(n.pitch) === pitchToMidi(tones[0]!)) ?? root;
    event.notes = tones.map((p, i) => (i === 0 ? { ...keep, pitch: p } : event.notes.find((n) => pitchToMidi(n.pitch) === pitchToMidi(p)) ?? { id: newId('n'), pitch: p }));
  },
});

// ====================================================================== dấu diễn tấu, láy, nốt hoa mỹ, cường độ

export const toggleArticulation = (eventId: string, art: Articulation): Command => ({
  label: 'Dấu diễn tấu',
  scope: (s) => cell(s, eventId),
  apply: (s) => {
    const { event } = chordOf(s, eventId);
    const has = event.articulations.includes(art);
    // staccato/staccatissimo/tenuto loại trừ lẫn nhau; accent/marcato loại trừ lẫn nhau
    const groups: Articulation[][] = [['staccato', 'staccatissimo'], ['accent', 'marcato']];
    const g = groups.find((x) => x.includes(art)) ?? [];
    event.articulations = event.articulations.filter((a) => a !== art && !g.includes(a));
    if (!has) event.articulations.push(art);
  },
});

export const toggleOrnament = (eventId: string, orn: Ornament): Command => ({
  label: 'Láy',
  scope: (s) => cell(s, eventId),
  apply: (s) => {
    const { event } = chordOf(s, eventId);
    const has = event.ornaments?.includes(orn);
    event.ornaments = has ? event.ornaments!.filter((o) => o !== orn) : [orn]; // mỗi nốt một dấu láy
    if (!event.ornaments.length) event.ornaments = undefined;
  },
});

/** Chèn nốt hoa mỹ trước nốt chọn (mặc định: acciaccatura, cao hơn một bậc) */
export const addGraceNote = (eventId: string, slash = true): Command => ({
  label: 'Nốt hoa mỹ',
  scope: (s) => cell(s, eventId),
  apply: (s) => {
    const loc = chordOf(s, eventId);
    const top = loc.event.notes.reduce((a, b) => (pitchToMidi(b.pitch) > pitchToMidi(a.pitch) ? b : a));
    const g: ChordEvent = {
      kind: 'chord', id: newId('e'), duration: { type: 'eighth', dots: 0 }, staff: loc.event.staff,
      notes: [{ id: newId('n'), pitch: diatonicAbove(s, loc.measureIndex, top.pitch, 1) }],
      lyrics: [], articulations: [], grace: true, graceSlash: slash || undefined, slurStart: true,
    };
    loc.event.slurStop = true;
    loc.voice.events.splice(loc.eventIndex, 0, g);
  },
});

/** Đặt/xóa ký hiệu cường độ tại vị trí nốt chọn */
export const setDynamic = (eventId: string, mark: DynamicMark | null): Command => ({
  label: 'Cường độ',
  scope: () => ALL,
  apply: (s) => {
    const loc = new ScoreIndex(s).event(eventId);
    if (!loc) throw new NotationError('Không tìm thấy nốt');
    const offset = eventTicksIn(s, loc.measureIndex, loc.voice.events)[loc.eventIndex]!.start;
    s.dynamics = s.dynamics.filter((d) => !(d.partId === loc.part.id && d.measureId === loc.measure.id && d.offset === offset));
    if (mark) s.dynamics.push({ id: newId('dy'), partId: loc.part.id, measureId: loc.measure.id, offset, mark });
  },
});

// ====================================================================== cấu trúc

export const setBarline = (measureIndex: number, barline: Barline): Command => ({
  label: 'Vạch nhịp',
  scope: () => ALL,
  apply: (s) => {
    s.measures[measureIndex]!.barlineRight = barline;
  },
});

export const toggleRepeat = (measureIndex: number, which: 'start' | 'end'): Command => ({
  label: which === 'start' ? 'Dấu lặp mở' : 'Dấu lặp đóng',
  scope: () => ALL,
  apply: (s) => {
    const m = s.measures[measureIndex]!;
    if (which === 'start') m.repeatStart = m.repeatStart ? undefined : true;
    else m.repeatEnd = m.repeatEnd ? undefined : true;
  },
});

export const setVolta = (measureIndex: number, numbers: number[] | null): Command => ({
  label: 'Khung lặp (volta)',
  scope: () => ALL,
  apply: (s) => {
    s.measures[measureIndex]!.volta = numbers?.length ? { numbers, closed: true } : undefined;
  },
});

/** Đổi hóa biểu từ ô nhịp này (không chuyển giọng nốt; dùng Transpose nếu muốn chuyển) */
export const setKeySignature = (measureIndex: number, fifths: number, mode: 'major' | 'minor' = 'major'): Command => ({
  label: 'Hóa biểu',
  scope: () => ALL,
  apply: (s) => {
    if (fifths < -7 || fifths > 7) throw new NotationError('Hóa biểu từ -7 đến 7');
    s.keyMap = s.keyMap.filter((k) => k.measureIndex !== measureIndex);
    s.keyMap.push({ measureIndex, fifths, mode });
    s.keyMap.sort((a, b) => a.measureIndex - b.measureIndex);
  },
});

export const setTimeSignature = (measureIndex: number, beats: number, beatType: number): Command => ({
  label: 'Số chỉ nhịp',
  scope: () => ALL,
  apply: (s) => {
    if (beats < 1 || beats > 32 || ![1, 2, 4, 8, 16, 32].includes(beatType)) throw new NotationError('Số chỉ nhịp không hợp lệ');
    s.timeSigMap = s.timeSigMap.filter((t) => t.measureIndex !== measureIndex);
    s.timeSigMap.push({ measureIndex, beats, beatType });
    s.timeSigMap.sort((a, b) => a.measureIndex - b.measureIndex);
  },
});

export const setTempo = (measureIndex: number, bpm: number, text?: string): Command => ({
  label: 'Tempo',
  scope: () => ALL,
  apply: (s) => {
    if (bpm < 20 || bpm > 400) throw new NotationError('Tempo từ 20 đến 400');
    s.tempoMap = s.tempoMap.filter((t) => !(t.measureIndex === measureIndex && t.offset === 0));
    s.tempoMap.push({ measureIndex, offset: 0, bpm, text });
    s.tempoMap.sort((a, b) => a.measureIndex - b.measureIndex || a.offset - b.offset);
  },
});

export { NotationError };

// ====================================================================== xác minh kết quả OMR

/** Đánh dấu các ô nhịp đã được người dùng kiểm tra (bỏ khỏi danh sách chưa xác minh) */
export const verifyMeasures = (from: number, to: number): Command => ({
  label: 'Xác minh nhận dạng',
  scope: () => ALL,
  apply: (s) => {
    const ids = new Set<string>();
    for (const part of s.parts) {
      for (const m of s.measures.slice(from, to + 1)) {
        for (const v of part.content[m.id] ?? []) for (const e of v.events) ids.add(e.id);
      }
    }
    s.provenance.unverifiedEventIds = s.provenance.unverifiedEventIds.filter((id) => !ids.has(id));
  },
});

/** Đánh dấu toàn bộ bản nhạc là chưa xác minh (sau OMR) */
export function markAllUnverified(s: ScoreDocument): void {
  s.provenance.source = 'omr';
  s.provenance.unverifiedEventIds = s.parts.flatMap((p) => Object.values(p.content).flatMap((vs) => vs.flatMap((v) => v.events.map((e) => e.id))));
}
