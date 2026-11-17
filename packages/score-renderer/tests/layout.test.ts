import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importMusicXml, ScoreIndex } from '../../music-core/src/index.js';
import { layoutScore, staffPosition } from '../src/index.js';

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
