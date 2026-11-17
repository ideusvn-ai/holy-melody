/**
 * Command + Undo/Redo nhiều cấp.
 * Mỗi command khai báo phạm vi ảnh hưởng; history chụp trạng thái trước/sau của đúng phạm vi đó
 * (một số ô nhịp của một part, hoặc toàn bài), nên undo luôn chính xác và tiết kiệm bộ nhớ.
 */
import { newId } from './ids.js';
import type { Duration, MusicEvent, Pitch, ScoreDocument, Voice } from './model.js';
import { createMeasure, ensureMeasureContent, measureRestEvent, ScoreIndex } from './score.js';
import { transposeScore, type TransposeScope, type TransposeSpec } from './transpose.js';

export type Scope = { kind: 'all' } | { kind: 'cells'; cells: { partId: string; measureId: string }[] };

export interface Command {
  label: string;
  scope(score: ScoreDocument): Scope;
  apply(score: ScoreDocument): void;
}

type Snapshot =
  | { kind: 'all'; data: string }
  | { kind: 'cells'; cells: { partId: string; measureId: string; data: string | null }[] };

interface Entry {
  label: string;
  before: Snapshot;
  after: Snapshot;
  affected: string[];
}

export interface ChangeEvent {
  revision: number;
  label: string;
  /** measure id bị ảnh hưởng; rỗng = toàn bài */
  affectedMeasureIds: string[];
  origin: 'do' | 'undo' | 'redo';
}

const META_KEYS = [
  'meta', 'parts', 'measures', 'keyMap', 'timeSigMap', 'tempoMap', 'chordSymbols', 'dynamics',
  'layout', 'playback', 'aiMeta', 'provenance',
] as const; // `advisor` cố ý không nằm trong undo: bỏ qua gợi ý không phải thao tác âm nhạc

function snap(score: ScoreDocument, scope: Scope): Snapshot {
  if (scope.kind === 'all') {
    const o: Record<string, unknown> = {};
    for (const k of META_KEYS) o[k] = (score as unknown as Record<string, unknown>)[k];
    return { kind: 'all', data: JSON.stringify(o) };
  }
  return {
    kind: 'cells',
    cells: scope.cells.map((c) => {
      const part = score.parts.find((p) => p.id === c.partId);
      const v = part?.content[c.measureId];
      return { ...c, data: v ? JSON.stringify(v) : null };
    }),
  };
}

function restore(score: ScoreDocument, s: Snapshot) {
  if (s.kind === 'all') {
    const o = JSON.parse(s.data) as Record<string, unknown>;
    for (const k of META_KEYS) {
      if (k in o) (score as unknown as Record<string, unknown>)[k] = o[k];
      else delete (score as unknown as Record<string, unknown>)[k];
    }
    return;
  }
  for (const c of s.cells) {
    const part = score.parts.find((p) => p.id === c.partId);
    if (!part) continue;
    if (c.data === null) delete part.content[c.measureId];
    else part.content[c.measureId] = JSON.parse(c.data) as Voice[];
  }
}

export class CommandHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<(e: ChangeEvent) => void>();

  constructor(public readonly score: ScoreDocument, private readonly limit = 500) {}

  onChange(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  execute(cmd: Command): void {
    const scope = cmd.scope(this.score);
    const before = snap(this.score, scope);
    cmd.apply(this.score);
    const after = snap(this.score, scope);
    const affected = scope.kind === 'all' ? [] : [...new Set(scope.cells.map((c) => c.measureId))];
    this.undoStack.push({ label: cmd.label, before, after, affected });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.bump(cmd.label, affected, 'do');
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }
  redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    restore(this.score, e.before);
    this.redoStack.push(e);
    this.bump(e.label, e.affected, 'undo');
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    restore(this.score, e.after);
    this.undoStack.push(e);
    this.bump(e.label, e.affected, 'redo');
    return true;
  }

  private bump(label: string, affectedMeasureIds: string[], origin: ChangeEvent['origin']) {
    this.score.revision++;
    const ev: ChangeEvent = { revision: this.score.revision, label, affectedMeasureIds, origin };
    for (const l of this.listeners) l(ev);
  }
}

// ====================================================================== Commands

const cellOfEvent = (score: ScoreDocument, eventId: string): Scope => {
  const loc = new ScoreIndex(score).event(eventId);
  if (!loc) throw new Error(`Không tìm thấy event ${eventId}`);
  return { kind: 'cells', cells: [{ partId: loc.part.id, measureId: loc.measure.id }] };
};
const cellOfNote = (score: ScoreDocument, noteId: string): Scope => {
  const loc = new ScoreIndex(score).note(noteId);
  if (!loc) throw new Error(`Không tìm thấy nốt ${noteId}`);
  return { kind: 'cells', cells: [{ partId: loc.part.id, measureId: loc.measure.id }] };
};

export const setPitch = (noteId: string, pitch: Pitch): Command => ({
  label: 'Đổi cao độ',
  scope: (s) => cellOfNote(s, noteId),
  apply: (s) => {
    new ScoreIndex(s).note(noteId)!.note.pitch = { ...pitch };
  },
});

export const setDuration = (eventId: string, duration: Duration): Command => ({
  label: 'Đổi trường độ',
  scope: (s) => cellOfEvent(s, eventId),
  apply: (s) => {
    const ev = new ScoreIndex(s).event(eventId)!.event;
    ev.duration = { ...duration };
    if (ev.kind === 'rest') ev.measureRest = undefined;
  },
});

/** Thay event bằng event khác (nhập nốt đè lên dấu lặng, v.v.) */
export const replaceEvent = (eventId: string, next: MusicEvent): Command => ({
  label: next.kind === 'rest' ? 'Đổi thành dấu lặng' : 'Nhập nốt',
  scope: (s) => cellOfEvent(s, eventId),
  apply: (s) => {
    const loc = new ScoreIndex(s).event(eventId)!;
    loc.voice.events[loc.eventIndex] = structuredClone(next);
  },
});

/** Xóa nốt = đổi thành dấu lặng cùng trường độ (hành vi chuẩn của phần mềm ký âm) */
export const deleteEvent = (eventId: string): Command => ({
  label: 'Xóa',
  scope: (s) => cellOfEvent(s, eventId),
  apply: (s) => {
    const loc = new ScoreIndex(s).event(eventId)!;
    const old = loc.event;
    loc.voice.events[loc.eventIndex] = { kind: 'rest', id: old.id, duration: old.duration, staff: old.staff };
  },
});

export const addChordTone = (eventId: string, pitch: Pitch): Command => ({
  label: 'Thêm nốt vào hợp âm',
  scope: (s) => cellOfEvent(s, eventId),
  apply: (s) => {
    const ev = new ScoreIndex(s).event(eventId)!.event;
    if (ev.kind !== 'chord') throw new Error('Chỉ thêm được vào nốt, không phải dấu lặng');
    ev.notes.push({ id: newId('n'), pitch: { ...pitch } });
  },
});

export const setLyric = (eventId: string, verse: number, text: string, syllabic: 'single' | 'begin' | 'middle' | 'end' = 'single'): Command => ({
  label: 'Sửa lời',
  scope: (s) => cellOfEvent(s, eventId),
  apply: (s) => {
    const ev = new ScoreIndex(s).event(eventId)!.event;
    if (ev.kind !== 'chord') throw new Error('Lời chỉ gắn với nốt');
    const t = text.normalize('NFC');
    const existing = ev.lyrics.find((l) => l.verse === verse);
    if (!t) ev.lyrics = ev.lyrics.filter((l) => l.verse !== verse);
    else if (existing) Object.assign(existing, { text: t, syllabic });
    else ev.lyrics.push({ id: newId('l'), verse, text: t, syllabic });
  },
});

export const insertMeasure = (atIndex: number): Command => ({
  label: 'Chèn ô nhịp',
  scope: () => ({ kind: 'all' }),
  apply: (s) => {
    const m = createMeasure(atIndex + 1);
    s.measures.splice(atIndex, 0, m);
    shiftMaps(s, atIndex, +1);
    renumber(s);
    for (const p of s.parts) ensureMeasureContent(s, p, atIndex);
  },
});

export const deleteMeasure = (index: number): Command => ({
  label: 'Xóa ô nhịp',
  scope: () => ({ kind: 'all' }),
  apply: (s) => {
    if (s.measures.length <= 1) throw new Error('Bản nhạc phải còn ít nhất một ô nhịp');
    const [m] = s.measures.splice(index, 1);
    for (const p of s.parts) delete p.content[m!.id];
    s.chordSymbols = s.chordSymbols.filter((c) => c.measureId !== m!.id);
    s.dynamics = s.dynamics.filter((d) => d.measureId !== m!.id);
    shiftMaps(s, index + 1, -1);
    renumber(s);
  },
});

/** Xóa nội dung ô nhịp (giữ ô, đặt dấu lặng nguyên ô) */
export const clearMeasure = (partId: string, measureId: string): Command => ({
  label: 'Xóa nội dung ô nhịp',
  scope: () => ({ kind: 'cells', cells: [{ partId, measureId }] }),
  apply: (s) => {
    const part = s.parts.find((p) => p.id === partId)!;
    const mi = s.measures.findIndex((m) => m.id === measureId);
    part.content[measureId] = part.staves.map((_, st) => ({ id: newId('v'), number: st * 4 + 1, events: [measureRestEvent(s, mi, st)] }));
  },
});

export const transpose = (spec: TransposeSpec, scope: TransposeScope = {}): Command => ({
  label: 'Chuyển giọng',
  scope: () => ({ kind: 'all' }),
  apply: (s) => {
    transposeScore(s, spec, scope);
  },
});

/** Gộp nhiều command thành một bước undo */
export const batch = (label: string, cmds: Command[]): Command => ({
  label,
  scope: () => ({ kind: 'all' }),
  apply: (s) => cmds.forEach((c) => c.apply(s)),
});

function shiftMaps(s: ScoreDocument, from: number, delta: number) {
  for (const arr of [s.keyMap, s.timeSigMap, s.tempoMap]) {
    for (const x of arr) if (x.measureIndex >= from && x.measureIndex > 0) x.measureIndex += delta;
  }
}

function renumber(s: ScoreDocument) {
  const pickup = s.measures[0]?.pickup ? 1 : 0;
  s.measures.forEach((m, i) => (m.number = String(i + 1 - pickup)));
}
