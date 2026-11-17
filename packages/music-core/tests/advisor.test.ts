import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeComposition, detectTone, dismissSuggestion, setRuleEnabled } from '../src/index.js';
import { buildScore } from './helpers.js';

const rules = (xs: { rule: string }[]) => xs.map((x) => x.rule);

test('nhận dạng 6 thanh tiếng Việt (cả NFC và NFD)', () => {
  assert.equal(detectTone('con'), 'ngang');
  assert.equal(detectTone('gà'), 'huyen');
  assert.equal(detectTone('Chúa'), 'sac');
  assert.equal(detectTone('hỏi'), 'hoi');
  assert.equal(detectTone('ngã'), 'nga');
  assert.equal(detectTone('Mẹ'), 'nang');
  assert.equal(detectTone('lạy'.normalize('NFD')), 'nang');
  assert.equal(detectTone('ước'), 'sac');
});

test('dấu thanh ngược hướng giai điệu → gợi ý; đúng hướng → không', () => {
  // "Con" (ngang) G4 → "gà" (huyền) B4: huyền đặt cao hơn → dễ nghe thành "ga"
  const bad = buildScore([{ name: 'Melody', measures: ['G4:q:Con B4:q:gà C5:q:Chúa C5:q:ơi', 'C4:w'] }]);
  const s1 = analyzeComposition(bad, { categories: ['lyrics'] });
  const t = s1.filter((x) => x.rule === 'lyrics.tone-contour');
  assert.equal(t.length, 1);
  assert.match(t[0]!.message, /"gà" \(dấu huyền\)/);
  assert.equal(t[0]!.noteIds.length, 2);

  const good = buildScore([{ name: 'Melody', measures: ['G4:q:Con E4:q:gà A4:q:Chúa A4:q:ơi', 'C4:w'] }]);
  assert.equal(analyzeComposition(good, { categories: ['lyrics'] }).filter((x) => x.rule === 'lyrics.tone-contour').length, 0);

  // "Lạy" (nặng) → "Chúa" (sắc) đi xuống → gợi ý
  const down = buildScore([{ name: 'Melody', measures: ['E4:q:Lạy C4:q:Chúa D4:h:con', 'C4:w'] }]);
  assert.ok(analyzeComposition(down, { categories: ['lyrics'] }).some((x) => /"Chúa" \(dấu sắc\)/.test(x.message)));
});

test('không so dấu thanh qua dấu lặng/ranh giới câu', () => {
  const s = buildScore([{ name: 'Melody', measures: ['G4:q:thương, B4:q:gà -:h', 'C4:w'] }]);
  assert.equal(analyzeComposition(s, { categories: ['lyrics'] }).filter((x) => x.rule === 'lyrics.tone-contour').length, 0);
});

test('quy tắc giai điệu: quãng nhảy lớn, tritone, bước nhảy không bù', () => {
  const s = buildScore([{ name: 'Melody', measures: ['C4:q D5:q F4:q B4:q', 'C4:q A4:q B4:q C5:q', 'C5:w'] }]);
  const r = rules(analyzeComposition(s, { categories: ['melody'] }));
  assert.ok(r.includes('melody.leap-large'), 'C4→D5');
  assert.ok(r.includes('melody.augmented'), 'F4→B4');
  assert.ok(r.includes('melody.leap-recovery'), 'C4→A4 rồi lên tiếp');
});

test('phối bè SATB: song song quãng 5, bắt chéo, âm vực', () => {
  const s = buildScore([
    { name: 'Soprano', measures: ['G4:h A4:h', 'C4:w'] },
    { name: 'Alto', measures: ['C4:h D4:h', 'E4:w'] },
    { name: 'Tenor', measures: ['E3:h F3:h', 'G3:w'] },
    { name: 'Bass', clef: 'F', measures: ['C3:h D3:h', 'C2:w'] },
  ]);
  const out = analyzeComposition(s);
  const r = rules(out);
  assert.ok(r.includes('harmony.parallel'), 'S–A song song quãng 5: G/C → A/D');
  assert.ok(r.includes('harmony.crossing'), 'ô 2: S C4 < A E4');
  assert.ok(out.some((x) => x.rule === 'range.voice' && /Bass/.test(x.message)), 'C2 thấp hơn âm vực Bass');
});

test('cấu trúc thánh ca: kết chưa về chủ âm, thiếu vạch kết', () => {
  const s = buildScore([{ name: 'Melody', measures: ['C4:q D4:q E4:q F4:q', 'G4:q F4:q E4:q D4:q'] }]);
  s.measures[1]!.barlineRight = 'regular';
  const r = rules(analyzeComposition(s, { categories: ['structure'] }));
  assert.ok(r.includes('structure.final-tonic'));
  assert.ok(r.includes('structure.final-barline'));

  const ok = buildScore([{ name: 'Melody', measures: ['C4:q D4:q E4:q F4:q', 'E4:q D4:q C4:h'] }]);
  assert.equal(analyzeComposition(ok, { categories: ['structure'] }).filter((x) => x.rule === 'structure.final-tonic').length, 0);
});

test('chỉ gợi ý: phân tích không thay đổi bản nhạc; bỏ qua và tắt quy tắc', () => {
  const s = buildScore([{ name: 'Melody', measures: ['G4:q:Con B4:q:gà C5:q:Chúa C5:q:ơi', 'C4:w'] }]);
  const before = JSON.stringify(s.parts);
  const all = analyzeComposition(s);
  assert.equal(JSON.stringify(s.parts), before);
  const target = all.find((x) => x.rule === 'lyrics.tone-contour')!;
  dismissSuggestion(s, target.id);
  const after = analyzeComposition(s);
  assert.ok(!after.some((x) => x.id === target.id));
  assert.equal(after.length, all.length - 1);
  // id ổn định giữa các lần phân tích
  assert.deepEqual(analyzeComposition(s).map((x) => x.id), after.map((x) => x.id));
  setRuleEnabled(s, 'melody.leap-recovery', false);
  assert.ok(!analyzeComposition(s).some((x) => x.rule === 'melody.leap-recovery'));
});

test('ô nhịp thiếu phách → gợi ý ký âm', () => {
  const s = buildScore([{ name: 'Melody', measures: ['C4:q D4:q E4:q', 'C4:w'] }]);
  assert.ok(analyzeComposition(s, { categories: ['notation'] }).some((x) => x.rule === 'notation.measure-fill'));
});
