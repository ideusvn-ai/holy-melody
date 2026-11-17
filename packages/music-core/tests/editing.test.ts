import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addChordTone, buildTimeline, CommandHistory, deleteEvent, deleteMeasure, HighlightIndex, insertMeasure, instrumentFifths,
  parsePitchName, pitchName, ScoreIndex, secondsToTick, setDuration, setLyric, setPitch, tickToSeconds, transpose,
  useDeterministicIds, type ChordEvent,
} from '../src/index.js';
import { buildScore } from './helpers.js';

test('undo/redo nhiều cấp chính xác, revision tăng, sự kiện thay đổi', () => {
  const restore = useDeterministicIds();
  const s = buildScore([{ name: 'M', measures: ['C4:q D4:q E4:q F4:q', 'G4:w'] }]);
  const h = new CommandHistory(s);
  const events: string[] = [];
  h.onChange((e) => events.push(`${e.origin}:${e.label}:${e.affectedMeasureIds.length}`));
  const idx = new ScoreIndex(s);
  const [n1, n2] = idx.allNoteIds();
  const original = JSON.stringify(s.parts);

  h.execute(setPitch(n1!, parsePitchName('A4')));
  h.execute(setDuration(idx.note(n2!)!.event.id, { type: 'eighth', dots: 0 }));
  h.execute(addChordTone(idx.note(n1!)!.event.id, parsePitchName('C5')));
  h.execute(setLyric(idx.note(n1!)!.event.id, 1, 'Chúa'));
  h.execute(insertMeasure(1));
  assert.equal(s.measures.length, 3);
  assert.equal(pitchName(new ScoreIndex(s).note(n1!)!.note.pitch), 'A4');

  while (h.canUndo()) h.undo();
  assert.equal(JSON.stringify(s.parts), original);
  assert.equal(s.measures.length, 2);

  while (h.canRedo()) h.redo();
  const ev = new ScoreIndex(s).note(n1!)!.event as ChordEvent;
  assert.equal(ev.notes.length, 2);
  assert.equal(ev.lyrics[0]!.text, 'Chúa');
  assert.equal(s.measures.length, 3);
  assert.equal(s.revision, 15);
  assert.equal(events[0], 'do:Đổi cao độ:1');
  restore();
});

test('xóa nốt thành dấu lặng; xóa ô nhịp; lệnh mới xóa nhánh redo', () => {
  const s = buildScore([{ name: 'M', measures: ['C4:w', 'D4:w', 'E4:w'] }]);
  const h = new CommandHistory(s);
  const id = new ScoreIndex(s).allNoteIds()[1]!;
  const evId = new ScoreIndex(s).note(id)!.event.id;
  h.execute(deleteEvent(evId));
  assert.equal(new ScoreIndex(s).event(evId)!.event.kind, 'rest');
  h.undo();
  assert.equal(new ScoreIndex(s).event(evId)!.event.kind, 'chord');
  h.execute(deleteMeasure(0));
  assert.equal(s.measures.length, 2);
  assert.equal(s.measures[0]!.number, '1');
  assert.equal(h.canRedo(), false);
});

test('chuyển giọng toàn bài: nốt, dấu hóa, hợp âm, hóa biểu', () => {
  const s = buildScore([{ name: 'M', measures: ['F4:q A4:q Bb4:q C5:q', 'E4:q F4:h.'] }], { keyFifths: -1 });
  s.chordSymbols.push({ id: 'ch_1', partId: s.parts[0]!.id, measureId: s.measures[0]!.id, offset: 0, root: { step: 'F', alter: 0 }, kind: 'major' });
  s.chordSymbols.push({ id: 'ch_2', partId: s.parts[0]!.id, measureId: s.measures[1]!.id, offset: 0, root: { step: 'C', alter: 0 }, kind: 'dominant', bass: { step: 'E', alter: 0 } });
  const h = new CommandHistory(s);
  h.execute(transpose({ by: 'key', targetFifths: 1, direction: 'up' }));
  const names = new ScoreIndex(s).allNoteIds().map((id) => pitchName(new ScoreIndex(s).note(id)!.note.pitch));
  assert.deepEqual(names, ['G4', 'B4', 'C5', 'D5', 'F#4', 'G4']);
  assert.equal(s.keyMap[0]!.fifths, 1);
  assert.deepEqual(s.chordSymbols[0]!.root, { step: 'G', alter: 0 });
  assert.deepEqual(s.chordSymbols[1]!.root, { step: 'D', alter: 0 });
  assert.deepEqual(s.chordSymbols[1]!.bass, { step: 'F', alter: 1 });
  h.undo();
  assert.equal(s.keyMap[0]!.fifths, -1);
});

test('chuyển theo bán cung chọn cách viết ít dấu hóa', () => {
  const s = buildScore([{ name: 'M', measures: ['C4:q E4:q G4:h'] }], { keyFifths: 0 });
  new CommandHistory(s).execute(transpose({ by: 'semitones', semitones: 1 }));
  assert.equal(s.keyMap[0]!.fifths, -5, 'Db trưởng (5 giáng) thay vì C# trưởng (7 thăng)');
  const names = new ScoreIndex(s).allNoteIds().map((id) => pitchName(new ScoreIndex(s).note(id)!.note.pitch));
  assert.deepEqual(names, ['Db4', 'F4', 'Ab4']);
});

test('chuyển một part, giữ part khác; transpose xuống có octave', () => {
  const s = buildScore([{ name: 'S', measures: ['C5:w'] }, { name: 'B', clef: 'F', measures: ['C3:w'] }]);
  new CommandHistory(s).execute(transpose({ by: 'semitones', semitones: -3 }, { partIds: [s.parts[0]!.id] }));
  const idx = new ScoreIndex(s);
  const [a, b] = idx.allNoteIds();
  assert.equal(pitchName(idx.note(a!)!.note.pitch), 'A4');
  assert.equal(pitchName(idx.note(b!)!.note.pitch), 'C3');
  assert.equal(s.keyMap[0]!.fifths, 0, 'chuyển một bè không đổi hóa biểu chung');
});

test('nhạc cụ chuyển giọng: hóa biểu viết của kèn Bb', () => {
  const s = buildScore([{ name: 'Clarinet in Bb', measures: ['D5:w'] }]);
  s.parts[0]!.instrument.transposeChromatic = -2;
  s.parts[0]!.instrument.transposeDiatonic = -1;
  assert.equal(instrumentFifths(s.parts[0]!), -2);
});

test('timeline: highlight theo tick, phát đoạn chọn, đổi tốc độ không đổi cao độ', () => {
  const s = buildScore([{ name: 'M', measures: ['C4:q D4:q E4:q F4:q', 'G4:h A4:h', 'B4:w'] }], { bpm: 120 });
  const tl = buildTimeline(s);
  const hi = new HighlightIndex(tl.spans);
  const name = (t: number) => hi.activeAt(t).map((x) => pitchName(new ScoreIndex(s).note(x.noteId)!.note.pitch));
  assert.deepEqual(name(0), ['C4']);
  assert.deepEqual(name(479), ['C4']);
  assert.deepEqual(name(480), ['D4']);
  assert.deepEqual(name(1920 + 960), ['A4']);
  assert.equal(tickToSeconds(tl, 1920), 2);
  assert.equal(tickToSeconds(tl, 1920, 0.5), 4);
  assert.equal(Math.round(secondsToTick(tl, 2)), 1920);

  const sel = buildTimeline(s, { measureRange: [1, 1] });
  assert.equal(sel.notes.length, 2);
  assert.equal(sel.notes[0]!.tick, 0);
  assert.equal(sel.notes[0]!.pitch, 67);

  const up = buildTimeline(s, { transposeSemitones: 2 });
  assert.equal(up.notes[0]!.pitch, 62);
  assert.equal(hi.firstTickOf(new ScoreIndex(s).allNoteIds()[4]!), 1920);
});

test('tempo map nhiều đoạn', () => {
  const s = buildScore([{ name: 'M', measures: ['C4:w', 'C4:w'] }], { bpm: 60 });
  s.tempoMap.push({ measureIndex: 1, offset: 0, bpm: 120 });
  const tl = buildTimeline(s);
  assert.equal(tickToSeconds(tl, 1920), 4);
  assert.equal(tickToSeconds(tl, 3840), 6);
});
