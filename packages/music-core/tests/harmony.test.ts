import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHarmony, chordName, CommandHistory, suggestHarmony, ScoreIndex, pitchName } from '../src/index.js';
import { buildScore } from './helpers.js';

const names = (v: { chords: Parameters<typeof chordName>[0][] }) => v.chords.map(chordName);

test('giai điệu Đô trưởng → C F G C (bản Đơn giản, thánh ca)', () => {
  const s = buildScore([{ name: 'Melody', measures: ['C4:q E4:q G4:q C5:q', 'F4:q A4:q C5:q A4:q', 'G4:q B4:q D5:q B4:q', 'C5:w'] }]);
  const vs = suggestHarmony(s, { style: 'sacred-hymn', rhythm: 'measure' });
  assert.ok(vs.length >= 1);
  assert.deepEqual(names(vs[0]!).map((n) => n.replace(/7$/, '')), ['C', 'F', 'G', 'C'], 'V hoặc V7 ở cadence');
  assert.equal(vs[0]!.numerals[0], 'I');
});

test('giọng thứ dùng V trưởng (thứ hòa âm) và kết về i', () => {
  const s = buildScore([{ name: 'M', measures: ['A4:q C5:q E5:h', 'D5:q F5:q A4:h', 'E5:q G#4:q B4:h', 'A4:w'] }], { keyFifths: 0 });
  s.keyMap[0]!.mode = 'minor';
  const v = suggestHarmony(s, { style: 'classical', rhythm: 'measure' })[0]!;
  assert.deepEqual(names(v), ['Am', 'Dm', 'E', 'Am']);
});

test('Fa trưởng: hợp âm viết đúng tên nốt (Bb, không phải A#)', () => {
  const s = buildScore([{ name: 'M', measures: ['F4:q A4:q C5:q A4:q', 'Bb4:q D5:q F5:q D5:q', 'C5:q E5:q G5:q E5:q', 'F5:w'] }], { keyFifths: -1 });
  assert.deepEqual(names(suggestHarmony(s, { rhythm: 'measure' })[0]!).map((n) => n.replace(/7$/, '')), ['F', 'Bb', 'C', 'F']);
});

test('jazz dùng hợp âm 7; nhiều phương án khác nhau; regenerate đổi kết quả nhưng vẫn kết về I', () => {
  const s = buildScore([{ name: 'M', measures: ['E4:q G4:q B4:q D5:q', 'F4:q A4:q C5:q E5:q', 'D4:q F4:q A4:q C5:q', 'G4:q B4:q D5:q F5:q', 'C5:w'] }]);
  const jazz = suggestHarmony(s, { style: 'jazz', rhythm: 'measure' });
  assert.ok(jazz.some((v) => v.chords.some((c) => c.kind === 'major-seventh' || c.kind === 'minor-seventh')));
  const a = suggestHarmony(s, { style: 'pop', rhythm: 'measure' });
  const ids = new Set(a.map((v) => names(v).join()));
  assert.equal(ids.size, a.length, 'không trùng phương án');
  for (let seed = 1; seed <= 5; seed++) {
    for (const v of suggestHarmony(s, { style: 'pop', rhythm: 'measure', seed })) assert.equal(names(v).at(-1), 'C');
  }
});

test('áp dụng không đổi giai điệu, thay hợp âm cũ, hoàn tác được', () => {
  const s = buildScore([{ name: 'M', measures: ['C4:q E4:q G4:q C5:q', 'G4:q B4:q D5:q B4:q', 'C5:w'] }]);
  s.chordSymbols.push({ id: 'old', partId: s.parts[0]!.id, measureId: s.measures[0]!.id, offset: 0, root: { step: 'A', alter: 0 }, kind: 'minor' });
  const melody = () => new ScoreIndex(s).allNoteIds().map((id) => pitchName(new ScoreIndex(s).note(id)!.note.pitch)).join();
  const before = melody();
  const h = new CommandHistory(s);
  const v = suggestHarmony(s)[0]!;
  h.execute(applyHarmony(v, s.parts[0]!.id));
  assert.equal(melody(), before);
  assert.ok(!s.chordSymbols.some((c) => c.id === 'old'));
  assert.equal(s.chordSymbols.length, v.chords.length);
  h.undo();
  assert.deepEqual(s.chordSymbols.map((c) => c.id), ['old']);
});

test('chia nửa ô nhịp trong 4/4 khi giai điệu dày', () => {
  const s = buildScore([{ name: 'M', measures: ['C5:q B4:q A4:q G4:q', 'F4:q E4:q D4:q G4:q', 'C4:w'] }]);
  const v = suggestHarmony(s, { rhythm: 'half' })[0]!;
  assert.ok(v.chords.some((c) => c.offset === 960));
  assert.equal(chordName(v.chords.at(-1)!), 'C');
});
