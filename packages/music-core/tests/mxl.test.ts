import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportMxl, importMxl, importMusicXml, readMxl, ScoreIndex, writeZip } from '../src/index.js';
import { fixture } from './helpers.js';

test('MXL: xuất rồi đọc lại giữ nguyên nốt và lời', async () => {
  const s = importMusicXml(fixture('hymn-satb-vi.musicxml'));
  const bytes = await exportMxl(s);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 2)), 'PK');
  assert.ok(bytes.length < fixture('hymn-satb-vi.musicxml').length / 3, 'được nén');
  const back = await importMxl(bytes);
  assert.deepEqual(new ScoreIndex(back).allNoteIds().sort(), new ScoreIndex(s).allNoteIds().sort());
  assert.equal(back.meta.title, 'Xin Chúa Thương Xót');
});

test('MXL không có container.xml vẫn đọc được; báo lỗi file hỏng', async () => {
  const enc = new TextEncoder();
  const zip = await writeZip([{ name: 'x/song.musicxml', data: enc.encode(fixture('external-piano.musicxml')) }]);
  assert.match(await readMxl(zip), /score-partwise/);
  await assert.rejects(readMxl(new Uint8Array([1, 2, 3])), /MXL hỏng/);
});
