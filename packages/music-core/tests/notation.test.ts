import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addGraceNote, addInterval, addTriad, buildTimeline, CommandHistory, exportMusicXml, importMusicXml, makeTuplet, pitchName,
  ScoreIndex, setDynamic, setKeySignature, setTimeSignature, toggleArticulation, toggleOrnament, toggleRepeat, toggleSlur, toggleTie,
  validateScore, voiceTicks, type ChordEvent,
} from '../src/index.js';
import { buildScore } from './helpers.js';

const setup = (m: string[], key = 0) => {
  const s = buildScore([{ name: 'M', measures: m }], { keyFifths: key });
  return { s, h: new CommandHistory(s), idx: () => new ScoreIndex(s) };
};
const evOf = (s: ReturnType<typeof setup>['s'], n: number) => new ScoreIndex(s).note(new ScoreIndex(s).allNoteIds()[n]!)!;

test('liên 3: một nốt đen → ba móc đơn liên 3, đủ ô nhịp, phát đúng tick', () => {
  const { s, h } = setup(['C4:q D4:q E4:q F4:q']);
  h.execute(makeTuplet(evOf(s, 1).event.id, 3));
  const v = s.parts[0]!.content[s.measures[0]!.id]![0]!;
  assert.equal(v.events.length, 6);
  assert.deepEqual(v.events.slice(1, 4).map((e) => [e.duration.type, e.duration.tuplet?.actual]), [['eighth', 3], ['eighth', 3], ['eighth', 3]]);
  assert.equal(voiceTicks(v.events), 1920);
  assert.equal(validateScore(s).length, 0);
  // round-trip MusicXML giữ liên 3
  const back = importMusicXml(exportMusicXml(s));
  assert.equal(back.parts[0]!.content[back.measures[0]!.id]![0]!.events[2]!.duration.tuplet?.actual, 3);
  h.undo();
  assert.equal(s.parts[0]!.content[s.measures[0]!.id]![0]!.events.length, 4);
});

test('liên 5 trên nốt trắng → 5 móc đơn', () => {
  const { s, h } = setup(['C4:h D4:h']);
  h.execute(makeTuplet(evOf(s, 0).event.id, 5));
  const v = s.parts[0]!.content[s.measures[0]!.id]![0]!;
  assert.equal(v.events[0]!.duration.type, 'eighth');
  assert.equal(voiceTicks(v.events), 1920);
});

test('hợp âm ba theo giọng: Rê trong Fa trưởng → D F A; G trong Fa trưởng → G Bb D', () => {
  const { s, h } = setup(['D4:q G4:q C4:h'], -1);
  h.execute(addTriad(evOf(s, 0).event.id));
  h.execute(addTriad(evOf(s, 3).event.id));
  const names = (i: number) => (new ScoreIndex(s).note(new ScoreIndex(s).allNoteIds()[i]!)!.event as ChordEvent).notes.map((n) => pitchName(n.pitch));
  assert.deepEqual(names(0), ['D4', 'F4', 'A4']);
  assert.deepEqual(names(3), ['G4', 'Bb4', 'D5']);
  h.execute(addTriad(evOf(s, 6).event.id, 1));
  assert.deepEqual(names(6), ['E4', 'G4', 'C5'], 'thể đảo 1');
});

test('thêm quãng 3/quãng 6 phía trên', () => {
  const { s, h } = setup(['C4:w']);
  const id = evOf(s, 0).event.id;
  h.execute(addInterval(id, 3));
  h.execute(addInterval(id, 6));
  assert.deepEqual((new ScoreIndex(s).event(id)!.event as ChordEvent).notes.map((n) => pitchName(n.pitch)), ['C4', 'E4', 'C5']);
});

test('dấu nối qua vạch nhịp: phát thành một nốt dài; bật lại thì gỡ', () => {
  const { s, h } = setup(['C4:h. G4:q', 'G4:h E4:h']);
  const g = evOf(s, 1);
  h.execute(toggleTie(g.note.id));
  const n = buildTimeline(s).notes.filter((x) => x.pitch === 67);
  assert.equal(n.length, 1);
  assert.equal(n[0]!.durationTicks, 480 + 960);
  h.execute(toggleTie(g.note.id));
  assert.equal(buildTimeline(s).notes.filter((x) => x.pitch === 67).length, 2);
  assert.throws(() => h.execute(toggleTie(evOf(s, 0).note.id)), /cùng cao độ/);
});

test('dấu luyến, dấu diễn tấu, láy, nốt hoa mỹ, cường độ → giữ qua MusicXML', () => {
  const { s, h } = setup(['C4:q D4:q E4:q F4:q']);
  const ids = new ScoreIndex(s).allNoteIds().map((id) => new ScoreIndex(s).note(id)!.event.id);
  h.execute(toggleSlur([ids[0]!, ids[2]!]));
  h.execute(toggleArticulation(ids[3]!, 'staccato'));
  h.execute(toggleArticulation(ids[3]!, 'marcato'));
  h.execute(toggleOrnament(ids[1]!, 'trill'));
  h.execute(toggleOrnament(ids[2]!, 'mordent'));
  h.execute(addGraceNote(ids[3]!));
  h.execute(setDynamic(ids[0]!, 'mf'));
  const back = importMusicXml(exportMusicXml(s));
  const evs = back.parts[0]!.content[back.measures[0]!.id]![0]!.events as ChordEvent[];
  assert.ok(evs[0]!.slurStart && evs[2]!.slurStop);
  assert.deepEqual(evs[1]!.ornaments, ['trill']);
  assert.deepEqual(evs[2]!.ornaments, ['mordent']);
  assert.ok(evs[3]!.grace && evs[3]!.graceSlash);
  assert.deepEqual(evs[4]!.articulations.sort(), ['marcato', 'staccato']);
  assert.equal(back.dynamics[0]!.mark, 'mf');
  // nốt hoa mỹ không làm sai độ dài ô nhịp
  assert.equal(validateScore(back).length, 0);
});

test('dấu lặp, đổi hóa biểu và số chỉ nhịp', () => {
  const { s, h } = setup(['C4:w', 'D4:w', 'E4:h. F4:q']);
  h.execute(toggleRepeat(0, 'start'));
  h.execute(toggleRepeat(1, 'end'));
  assert.deepEqual(buildTimeline(s).measures.map((m) => m.measureIndex), [0, 1, 0, 1, 2]);
  h.execute(setKeySignature(2, 2));
  h.execute(setTimeSignature(2, 3, 4));
  assert.equal(s.keyMap.find((k) => k.measureIndex === 2)?.fifths, 2);
  const back = importMusicXml(exportMusicXml(s));
  assert.equal(back.timeSigMap.find((t) => t.measureIndex === 2)?.beats, 3);
  assert.equal(back.keyMap.find((k) => k.measureIndex === 2)?.fifths, 2);
});
