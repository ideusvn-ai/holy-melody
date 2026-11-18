import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSystems, systemCrop } from '../src/index.js';

/** Ảnh tổng hợp: khuông 5 dòng (interline 14), khuông đôi nối bằng vạch đầu dòng, và một khuông đơn */
function page(): { g: Uint8Array; w: number; h: number } {
  const w = 1000;
  const h = 1200;
  const g = new Uint8Array(w * h).fill(255);
  const staff = (top: number) => {
    for (let k = 0; k < 5; k++) for (let x = 80; x < 950; x++) { g[(top + k * 14) * w + x] = 0; g[(top + k * 14 + 1) * w + x] = 0; }
  };
  const bar = (x: number, y1: number, y2: number) => { for (let y = y1; y <= y2; y++) { g[y * w + x] = 0; g[y * w + x + 1] = 0; } };
  // hệ thống 1: khuông đôi (piano) 100 & 200, nối bằng vạch
  staff(100); staff(200); bar(80, 100, 257);
  // vài nốt/lời giữa hai khuông không được nhầm là dòng kẻ
  for (let x = 300; x < 340; x++) for (let y = 175; y < 182; y++) g[y * w + x] = 0;
  // hệ thống 2: khuông đôi 420 & 520
  staff(420); staff(520); bar(80, 420, 577);
  // hệ thống 3: khuông đơn
  staff(800); bar(80, 800, 857);
  return { g, w, h };
}

test('tìm hệ thống: khuông đôi piano nằm chung một hệ thống, khuông đơn tách riêng', () => {
  const { g, w, h } = page();
  const s = detectSystems(g, w, h, 1, 14);
  assert.deepEqual(s.map((x) => x.staves.length), [2, 2, 1]);
  assert.equal(s[0]!.top, 100);
  assert.ok(Math.abs(s[0]!.bottom - 257) <= 1);
  const c = systemCrop(s, 0, w, h, 14)!;
  assert.ok(c.y < 100 && c.y + c.h > 260 && c.y + c.h < 420, 'vùng cắt gồm trọn hệ thống 1 và lời ca phía dưới, chưa tới hệ thống 2');
});
