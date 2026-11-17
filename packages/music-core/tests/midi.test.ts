import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, exportMidi, importMidi, importMusicXml, parseMidiFile, pitchName, ScoreIndex, writeMidiFile } from '../src/index.js';
import { buildScore, fixture } from './helpers.js';

test('xuất MIDI: tempo, nhịp, hóa biểu, track, program, cao độ, trường độ', () => {
  const s = buildScore(
    [{ name: 'Melody', measures: ['C4:q D4:q E4:h', 'G4:w'] }, { name: 'Bass', clef: 'F', measures: ['C3:w', 'G2:w'] }],
    { bpm: 90, beats: 4 },
  );
  s.parts[1]!.instrument.program = 32;
  s.keyMap[0]!.fifths = 0;
  const f = parseMidiFile(exportMidi(s));
  assert.equal(f.format, 1);
  assert.equal(f.division, 480);
  assert.equal(f.tracks.length, 3);
  const tempo = f.tracks[0]!.events.find((e) => e.kind === 'tempo');
  assert.ok(tempo && tempo.kind === 'tempo');
  assert.equal(Math.round(60_000_000 / tempo.microsecondsPerQuarter), 90);
  assert.ok(f.tracks[0]!.events.some((e) => e.kind === 'timeSignature' && e.numerator === 4 && e.denominator === 4));
  const prog = f.tracks[2]!.events.find((e) => e.kind === 'programChange');
  assert.ok(prog && prog.kind === 'programChange' && prog.program === 32);
  const ons = f.tracks[1]!.events.filter((e) => e.kind === 'noteOn');
  assert.deepEqual(ons.map((e) => (e.kind === 'noteOn' ? [e.tick, e.pitch] : [])), [[0, 60], [480, 62], [960, 64], [1920, 67]]);
  const off = f.tracks[1]!.events.find((e) => e.kind === 'noteOff' && e.pitch === 64)!;
  assert.equal(off.tick, 1920);
});

test('xuất MIDI giữ nhạc cụ chuyển giọng (Bb clarinet viết D5 → kêu C5)', () => {
  const s = buildScore([{ name: 'Clarinet', measures: ['D5:w'] }]);
  s.parts[0]!.instrument.transposeChromatic = -2;
  s.parts[0]!.instrument.transposeDiatonic = -1;
  const on = parseMidiFile(exportMidi(s)).tracks[1]!.events.find((e) => e.kind === 'noteOn');
  assert.ok(on && on.kind === 'noteOn' && on.pitch === 72);
});

test('MIDI → Score: đúng tempo, cao độ, trường độ, dấu nối qua vạch nhịp', () => {
  const s = buildScore([{ name: 'Melody', measures: ['C4:q D4:q E4:h', 'G4:w'] }], { bpm: 66 });
  const { score, warnings } = importMidi(exportMidi(s));
  assert.deepEqual(warnings, []);
  assert.equal(score.tempoMap[0]!.bpm, 66);
  assert.equal(score.measures.length, 2);
  const tl1 = buildTimeline(s).notes.map((n) => [n.tick, n.pitch, n.durationTicks]);
  const tl2 = buildTimeline(score).notes.map((n) => [n.tick, n.pitch, n.durationTicks]);
  assert.deepEqual(tl2, tl1);

  // nốt kéo qua vạch nhịp → tách + nối
  const t = buildScore([{ name: 'X', measures: ['-:h. C4:q', 'C4:q -:h.'] }]);
  const idx = new ScoreIndex(t);
  const [a, b] = idx.allNoteIds();
  idx.note(a!)!.note.tieStart = true;
  idx.note(b!)!.note.tieStop = true;
  const back = importMidi(exportMidi(t)).score;
  const notes = buildTimeline(back).notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.tick, 1440);
  assert.equal(notes[0]!.durationTicks, 960);
});

test('MIDI → Score: đặt tên nốt theo hóa biểu giáng', () => {
  const s = buildScore([{ name: 'M', measures: ['Bb4:q Eb4:q F4:h'] }], { keyFifths: -2 });
  const back = importMidi(exportMidi(s)).score;
  const names = new ScoreIndex(back).allNoteIds().map((id) => pitchName(new ScoreIndex(back).note(id)!.note.pitch));
  assert.deepEqual(names, ['Bb4', 'Eb4', 'F4']);
});

test('MIDI có repeat được unroll đúng thứ tự', () => {
  const s = importMusicXml(fixture('external-piano.musicxml'));
  const f = parseMidiFile(exportMidi(s));
  const firstTrackOns = f.tracks[1]!.events.filter((e) => e.kind === 'noteOn' && e.pitch === 65);
  // F4 đầu ô 1 xuất hiện 2 lần (lặp) + F4 ô volta 2 = 3
  assert.equal(firstTrackOns.length, 3);
});

test('parser chịu được running status và noteOn velocity 0', () => {
  const bytes = writeMidiFile({ format: 0, division: 96, tracks: [{ events: [] }] });
  // tự chèn track có running status
  const track = [0x00, 0x90, 60, 100, 0x60, 60, 0, 0x00, 0xff, 0x2f, 0x00];
  const hdr = Array.from(bytes.subarray(0, 14));
  hdr[11] = 1;
  const all = new Uint8Array([...hdr, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length, ...track]);
  const f = parseMidiFile(all);
  const kinds = f.tracks[0]!.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['noteOn', 'noteOff', 'endOfTrack']);
  assert.throws(() => parseMidiFile(new Uint8Array([1, 2, 3, 4, 5])));
});
