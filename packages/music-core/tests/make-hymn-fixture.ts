// Sinh fixture "hymn-satb-vi.musicxml": thánh ca 4 bè, lời Việt, F trưởng 3/4, có ô lấy đà.
// Cố ý chứa vài lỗi nhỏ để kiểm thử Trợ lý soạn nhạc.
import { writeFileSync } from 'node:fs';
import { exportMusicXml, useDeterministicIds } from '../src/index.js';
import { buildScore } from './helpers.js';

useDeterministicIds();
const S = ['A4:q:Xin', 'C5:q:Chúa A4:q:thương G4:q:xót', 'F4:h:con G4:q:đây', 'A4:h.:hiền', 'C5:q:Lòng D5:q:con A4:q:tín', 'Bb4:q:thác C5:q:nơi D5:q:Ngài,',
  'C5:q:dẫn A4:q:đưa F4:q:đoàn', 'G4:q:con E4:q:qua G4:q:đời', 'F4:h.:Amen'];
const A = ['F4:q', 'F4:q F4:q E4:q', 'C4:h E4:q', 'F4:h.', 'F4:q F4:q F4:q', 'F4:q F4:q F4:q', 'F4:q F4:q C4:q', 'E4:q C4:q E4:q', 'C4:h.'];
const T = ['C4:q', 'A3:q C4:q C4:q', 'A3:h C4:q', 'C4:h.', 'A3:q Bb3:q C4:q', 'D4:q C4:q Bb3:q', 'A3:q C4:q A3:q', 'C4:q G3:q Bb3:q', 'A3:h.'];
const B = ['F3:q', 'F3:q F3:q C3:q', 'F3:h C3:q', 'F3:h.', 'F3:q Bb2:q F3:q', 'Bb2:q A2:q Bb2:q', 'F3:q F3:q F3:q', 'C3:q C3:q C3:q', 'F2:h.'];
const s = buildScore([
  { name: 'Soprano', measures: S }, { name: 'Alto', measures: A },
  { name: 'Tenor', measures: T }, { name: 'Bass', clef: 'F', measures: B },
], { keyFifths: -1, beats: 3, bpm: 76 });
s.meta.title = 'Xin Chúa Thương Xót';
s.parts[2]!.staves[0]!.clef = { sign: 'G', line: 2, octaveChange: -1 }; // khóa Sol quãng 8 cho Tenor
s.meta.composer = 'Fixture kiểm thử';
s.measures[0]!.pickup = true;
s.measures[0]!.actualTicks = 480;
s.measures.forEach((m, i) => (m.number = String(i)));
s.parts.forEach((p, i) => (p.instrument = { name: p.name, program: 52, channel: i, transposeChromatic: 0, transposeDiatonic: 0 }));
s.chordSymbols.push(
  { id: 'ch_1', partId: s.parts[0]!.id, measureId: s.measures[1]!.id, offset: 0, root: { step: 'F', alter: 0 }, kind: 'major' },
  { id: 'ch_2', partId: s.parts[0]!.id, measureId: s.measures[2]!.id, offset: 960, root: { step: 'C', alter: 0 }, kind: 'major' },
  { id: 'ch_3', partId: s.parts[0]!.id, measureId: s.measures[5]!.id, offset: 0, root: { step: 'B', alter: -1 }, kind: 'major' },
  { id: 'ch_4', partId: s.parts[0]!.id, measureId: s.measures[7]!.id, offset: 0, root: { step: 'C', alter: 0 }, kind: 'dominant' },
  { id: 'ch_5', partId: s.parts[0]!.id, measureId: s.measures[8]!.id, offset: 0, root: { step: 'F', alter: 0 }, kind: 'major' },
);
writeFileSync(new URL('./fixtures/hymn-satb-vi.musicxml', import.meta.url), exportMusicXml(s));
console.log('ok');
