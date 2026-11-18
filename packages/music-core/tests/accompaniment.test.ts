import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accompany, buildTimeline, chordsForAccompaniment, DEFAULT_PLAYER_SETTINGS, importMusicXml, measureAtTick } from '../src/index.ts';

const load = (n: string) => importMusicXml(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('đệm hợp âm: tự suy ra hợp âm, có bass + hợp âm, dời bản nhạc sau dạo đầu + đếm vào', () => {
  const s = load('hymn-satb-vi.musicxml');
  const base = buildTimeline(s);
  const chords = chordsForAccompaniment(s);
  assert.ok(chords.length > 0);
  const t = accompany(s, base, DEFAULT_PLAYER_SETTINGS, chords);
  const pre = t.preroll.introTicks + t.preroll.countInTicks;
  assert.ok(t.preroll.introTicks > 0 && t.preroll.countInTicks > 0);
  assert.equal(t.totalTicks, base.totalTicks + pre);
  assert.equal(t.measures[0]!.startTick, base.measures[0]!.startTick + pre);
  assert.equal(t.spans[0]!.startTick, base.spans[0]!.startTick + pre);
  // đếm vào: số tiếng gõ = số phách (trừ phách lấy đà)
  const clicks = t.notes.filter((n) => n.channel === 9);
  assert.equal(clicks.length, t.preroll.beats);
  assert.ok(clicks.every((c) => c.tick >= t.preroll.introTicks && c.tick < pre));
  const acc = t.notes.filter((n) => n.partId === '__acc' && n.tick >= pre);
  assert.ok(acc.some((n) => n.pitch < 52), 'có bass');
  assert.ok(acc.some((n) => n.pitch >= 53), 'có hợp âm');
  // nốt đệm không lệch khỏi ô nhịp
  for (const n of acc) assert.ok(measureAtTick(t, n.tick), 'đệm nằm trong ô nhịp');
  // giai điệu giữ nguyên số nốt
  assert.equal(t.notes.filter((n) => n.partId !== '__acc' && n.partId !== '__click' && n.tick >= pre).length, base.notes.length);
});

test('tắt đệm/dạo đầu/đếm vào: timeline như cũ; transpose + nhạc cụ áp dụng khi phát', () => {
  const s = load('hymn-satb-vi.musicxml');
  const base = buildTimeline(s);
  const t = accompany(s, base, { ...DEFAULT_PLAYER_SETTINGS, chordVolume: 0, intro: false, countIn: false, transpose: 2, program: 19 }, chordsForAccompaniment(s));
  assert.equal(t.totalTicks, base.totalTicks);
  assert.equal(t.notes.length, base.notes.length);
  assert.ok(t.notes.every((n, i) => n.program === 19));
  assert.deepEqual(t.notes.map((n) => n.pitch).sort(), base.notes.map((n) => n.pitch + 2).sort());
});

test('nhịp 3/4: kiểu valse (bass phách 1, hợp âm phách 2–3)', () => {
  const s = load('hymn-satb-vi.musicxml');
  s.timeSigMap = [{ measureIndex: 0, beats: 3, beatType: 4 }];
  const base = buildTimeline(s);
  const t = accompany(s, base, { ...DEFAULT_PLAYER_SETTINGS, intro: false }, chordsForAccompaniment(s));
  const pm = t.measures[2]!;
  const inM = t.notes.filter((n) => n.partId === '__acc' && n.tick >= pm.startTick && n.tick < pm.endTick);
  const rel = [...new Set(inM.map((n) => n.tick - pm.startTick))].sort((a, b) => a - b);
  assert.deepEqual(rel, [0, 480, 960]);
  assert.ok(inM.filter((n) => n.tick === pm.startTick).every((n) => n.pitch < 53), 'phách 1 chỉ có bass');
});

test('chỉ phát MIDI (không hoà âm): không có đệm, không dạo đầu; vẫn đếm vào nếu bật', async () => {
  const { buildScore } = await import('./helpers.js');
  const { accompany, buildTimeline, DEFAULT_PLAYER_SETTINGS, chordsForAccompaniment } = await import('../src/index.js');
  const s = buildScore([{ name: 'S', measures: ['C4:q E4:q G4:q C5:q', 'D4:q F4:q A4:q D5:q', 'C4:w'] }]);
  const base = buildTimeline(s);
  const tl = accompany(s, base, { ...DEFAULT_PLAYER_SETTINGS, harmony: false }, chordsForAccompaniment(s));
  assert.equal(tl.notes.filter((n) => n.partId === '__acc').length, 0);
  assert.equal(tl.preroll.introTicks, 0);
  assert.ok(tl.preroll.countInTicks > 0);
  assert.equal(tl.notes.filter((n) => n.partId !== '__click').length, base.notes.length);
});
