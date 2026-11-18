import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateInterline, fastOmrScale } from '../src/index.ts';

/** Ảnh tổng hợp: các khuông 5 dòng (dày 2 px) cách nhau `il` px + vài nốt đen */
function synth(il: number, w = 1200, h = 1600) {
  const g = new Uint8Array(w * h).fill(255);
  for (let s = 0; s < 8; s++) {
    const top = 120 + s * (il * 4 + il * 7);
    if (top + il * 4 + 2 >= h) break;
    for (let l = 0; l < 5; l++) for (let t = 0; t < 2; t++) for (let x = 60; x < w - 60; x++) g[(top + l * il + t) * w + x] = 0;
    for (let n = 0; n < 20; n++) {
      const cx = 100 + n * 50, cy = top + ((n * 7) % 9) * (il / 2);
      for (let y = -il / 2; y < il / 2; y++) for (let x = -il * 0.6; x < il * 0.6; x++) if (cy + y > 0) g[Math.round(cy + y) * w + Math.round(cx + x)] = 0;
    }
  }
  return g;
}

test('ước lượng interline từ ảnh khuông nhạc', () => {
  for (const il of [12, 16, 20, 28, 40]) {
    const got = estimateInterline(synth(il), 1200, 1600)!;
    assert.ok(Math.abs(got - il) <= 1, `il=${il} got=${got}`);
  }
  assert.equal(estimateInterline(new Uint8Array(400 * 400).fill(255), 400, 400), null);
});

test('tỉ lệ thu nhỏ chế độ nhanh', () => {
  assert.equal(fastOmrScale(16), 1);
  assert.equal(fastOmrScale(null), 1);
  assert.ok(Math.abs(fastOmrScale(21) * 20 - 15) < 0.01);
  assert.ok(fastOmrScale(40) * 39 >= 14.9);
});
