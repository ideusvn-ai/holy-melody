import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline, exportMusicXml, importMusicXml, playOrder, pitchName, ScoreIndex, validateScore, type ChordEvent,
} from '../src/index.js';
import { buildScore, fixture } from './helpers.js';

test('import MusicXML ngoài: cấu trúc, hóa biểu, tempo, lời Việt, hợp âm ký hiệu', () => {
  const s = importMusicXml(fixture('external-piano.musicxml'));
  assert.equal(s.meta.title, 'Lạy Chúa Xin Thương');
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0]!.staves.length, 2);
  assert.equal(s.parts[0]!.staves[1]!.clef.sign, 'F');
  assert.equal(s.measures.length, 3);
  assert.equal(s.keyMap[0]!.fifths, -1);
  assert.equal(s.tempoMap[0]!.bpm, 72);
  assert.equal(s.chordSymbols.length, 2);
  assert.equal(s.chordSymbols[1]!.kind, 'dominant');
  const m1 = s.parts[0]!.content[s.measures[0]!.id]!;
  assert.equal(m1.length, 2, 'hai voice (khuông trên, khuông dưới)');
  const v1 = m1[0]!.events as ChordEvent[];
  assert.deepEqual(v1.map((e) => e.lyrics[0]?.text ?? ''), ['Lạy', 'Chúa', 'xin', '', '', 'thương,']);
  assert.equal(v1[2]!.duration.tuplet?.actual, 3);
  const lower = m1[1]!.events[0] as ChordEvent;
  assert.equal(lower.notes.length, 3, 'hợp âm 3 nốt');
  assert.equal(lower.staff, 1);
  assert.equal(validateScore(s).filter((i) => i.severity === 'error').length, 0);
});

test('repeat + volta: thứ tự phát 1-2-1-3', () => {
  const s = importMusicXml(fixture('external-piano.musicxml'));
  assert.ok(s.measures[0]!.repeatStart);
  assert.ok(s.measures[1]!.repeatEnd);
  assert.deepEqual(s.measures[1]!.volta?.numbers, [1]);
  assert.deepEqual(s.measures[2]!.volta?.numbers, [2]);
  assert.deepEqual(playOrder(s).map((x) => x.index), [0, 1, 0, 2]);
});

test('liên ba được tính tick chính xác và dấu nối gộp nốt trong timeline', () => {
  const s = importMusicXml(fixture('external-piano.musicxml'));
  const tl = buildTimeline(s, { unrollRepeats: false });
  const top = tl.notes.filter((n) => n.channel === 0 && n.pitch >= 65).sort((a, b) => a.tick - b.tick);
  // F4 0, A4 480, triplets 960/1120/1280, C5 1440 (nối sang ô 2 thêm 960)
  assert.deepEqual(top.slice(0, 6).map((n) => n.tick), [0, 480, 960, 1120, 1280, 1440]);
  const c5 = top.find((n) => n.pitch === 72)!;
  assert.equal(c5.durationTicks, 480 + 960);
  assert.equal(c5.noteIds.length, 2, 'cả hai nốt nối đều được highlight');
});

test('xuất rồi nhập lại không mất nốt, giữ ID, cao độ, trường độ, lời', () => {
  const s = importMusicXml(fixture('external-piano.musicxml'));
  const xml = exportMusicXml(s);
  const s2 = importMusicXml(xml);
  const a = new ScoreIndex(s);
  const b = new ScoreIndex(s2);
  const ids = a.allNoteIds();
  assert.ok(ids.length >= 12);
  assert.deepEqual(b.allNoteIds().sort(), [...ids].sort());
  for (const id of ids) {
    const x = a.note(id)!;
    const y = b.note(id)!;
    assert.equal(pitchName(y.note.pitch), pitchName(x.note.pitch), id);
    assert.deepEqual(y.event.duration, x.event.duration);
    assert.equal(y.event.lyrics[0]?.text, x.event.lyrics[0]?.text);
    assert.equal(y.measure.id, x.measure.id);
  }
  assert.deepEqual(playOrder(s2).map((x) => x.index), [0, 1, 0, 2]);
  assert.equal(s2.chordSymbols.length, 2);
  assert.deepEqual(buildTimeline(s2).notes.map((n) => [n.tick, n.pitch]), buildTimeline(s).notes.map((n) => [n.tick, n.pitch]));
});

test('round-trip bài nhiều bè, hóa biểu thăng, nhiều trang', () => {
  const m = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'F#4:q E4:q D4:h' : 'D4:q:Hát E4:q:mừng F#4:q:Chúa G4:q:ơi'));
  const s = buildScore([{ name: 'Soprano', measures: m }, { name: 'Bass', clef: 'F', measures: m.map(() => 'D3:w') }], { keyFifths: 2 });
  s.measures[20]!.pageBreak = true;
  const s2 = importMusicXml(exportMusicXml(s));
  assert.equal(s2.measures.length, 40);
  assert.equal(s2.parts.length, 2);
  assert.equal(s2.keyMap[0]!.fifths, 2);
  assert.ok(s2.measures[20]!.pageBreak);
  assert.equal(new ScoreIndex(s2).allNoteIds().length, new ScoreIndex(s).allNoteIds().length);
});

test('xuất MusicXML có dấu hóa đúng theo hóa biểu', () => {
  const s = buildScore([{ name: 'Melody', measures: ['F#4:q F4:q F4:q F#4:q'] }], { keyFifths: 1 });
  const xml = exportMusicXml(s);
  const accs = [...xml.matchAll(/<accidental>(\w+)<\/accidental>/g)].map((m) => m[1]);
  assert.deepEqual(accs, ['natural', 'sharp']);
});

test('báo lỗi rõ ràng với file không phải MusicXML', () => {
  assert.throws(() => importMusicXml('<html></html>'), /Không phải MusicXML/);
  assert.throws(() => importMusicXml('<score-partwise><part-list></score-partwise>'));
});
