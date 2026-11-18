import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importMusicXml, ScoreIndex } from '../../music-core/src/index.js';
import { HEAD_W, layoutScore, staffPosition } from '../src/index.js';
import { buildScore } from '../../music-core/tests/helpers.js';

const hymn = importMusicXml(readFileSync(new URL('../../music-core/tests/fixtures/hymn-satb-vi.musicxml', import.meta.url), 'utf8'));

test('vị trí trên khuông theo khóa', () => {
  assert.equal(staffPosition({ step: 'E', alter: 0, octave: 4 }, { sign: 'G', line: 2 }), 0);
  assert.equal(staffPosition({ step: 'F', alter: 0, octave: 5 }, { sign: 'G', line: 2 }), 8);
  assert.equal(staffPosition({ step: 'G', alter: 0, octave: 2 }, { sign: 'F', line: 4 }), 0);
  assert.equal(staffPosition({ step: 'E', alter: 0, octave: 3 }, { sign: 'G', line: 2, octaveChange: -1 }), 0);
});

for (const width of [560, 900, 1300]) {
  test(`dàn trang ${width}px: mọi nốt có vị trí, không tràn lề, lời ca không chồng`, () => {
    const L = layoutScore(hymn, { width, sp: 8 });
    const ids = new ScoreIndex(hymn).allNoteIds();
    for (const id of ids) assert.ok(L.heads.has(id), id);
    for (const sys of L.systems) {
      const last = sys.measures[sys.measures.length - 1]!;
      assert.ok(last.x + last.width <= width - L.marginX + 0.5, 'không vượt lề phải');
      assert.ok(L.marginX >= 40, 'lề đủ rộng');
      assert.ok(sys.measures[0]!.x > L.marginX, 'khuông bắt đầu sau lề trái');
    }
    // lời ca trên cùng một khuông, cùng hệ thống: khoảng cách giữa tâm >= nửa tổng bề rộng ước tính
    const lyr = L.events.filter((e) => e.lyrics.length).map((e) => ({ x: e.x, y: e.staffY, w: e.lyrics[0]!.text.length * 6.2 }));
    lyr.sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 1; i < lyr.length; i++) {
      const a = lyr[i - 1]!, b = lyr[i]!;
      if (a.y !== b.y || b.x < a.x) continue;
      assert.ok(b.x - a.x >= (a.w + b.w) / 2 - 1, `lời chồng nhau tại x=${a.x.toFixed(0)}`);
    }
  });
}

test('tránh chồng: hợp âm quãng 2 lệch đầu nốt, dấu hoá xếp cột', () => {
  const s = buildScore([{ name: 'S', measures: ['C4+D4:q E4+F4+G4:q F#4+G#4:q -:q'] }]);
  const L = layoutScore(s, { width: 900 });
  const ev = L.events.filter((e) => e.heads.length);
  const dx = (i: number) => ev[i]!.heads.map((h) => Math.round(h.x - ev[i]!.x));
  assert.deepEqual(dx(0), [0, Math.round(HEAD_W * L.sp)]);
  assert.deepEqual(dx(1), [0, Math.round(HEAD_W * L.sp), 0]);
  const acc = ev[2]!.heads.map((h) => h.accX!);
  assert.ok(acc[0]! < acc[1]! - L.sp * 0.8, 'hai dấu thăng không đè nhau');
});

test('bố cục theo bản gốc: xuống dòng đúng chỗ ngắt dòng, kể cả khi dòng chật', () => {
  const s = buildScore([{ name: 'S', measures: Array.from({ length: 9 }, () => 'C4:e D4:e E4:e F4:e G4:e A4:e B4:e C5:e') }]);
  s.layout = { ...s.layout, exactBreaks: true };
  s.measures[6]!.systemBreak = true;
  const L = layoutScore(s, { width: 700 });
  assert.deepEqual(L.systems.map((x) => x.measures.length), [6, 3]);
});
