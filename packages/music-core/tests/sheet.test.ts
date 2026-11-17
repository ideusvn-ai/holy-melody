import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { applyMissedKey, concatScores, hasExplicitTime, cursorX, extractOmrGeometry, extractOmrSignals, extractSheetGeometry, importMusicXml, validateMusic, specialNotation, autoFixIssues, regionOf } from '../src/index.ts';

const fx = (n: string) => new URL(`./fixtures/${n}`, import.meta.url);

test('đọc tọa độ pixel từ sheet .omr của Audiveris (đúng 9 ô, 2 hệ thống, ô lấy đà)', () => {
  const xml = readFileSync(fx('audiveris-hymn.sheet.xml'), 'utf8');
  const g = extractOmrGeometry([xml])!;
  assert.equal(g.length, 9);
  assert.deepEqual([...new Set(g.map((m) => m.system))], [0, 1]);
  const m0 = g[0]!;
  assert.ok(Math.abs(m0.x - 178 / 2479) < 1e-6 && Math.abs(m0.w - (524 - 178) / 2479) < 1e-6);
  // dòng kẻ trên cùng y=496 nằm trong hộp
  assert.ok(m0.y < 496 / 3508 && m0.y + m0.h > 600 / 3508);
  // slot thứ 2 của ô 1: time-offset 1/4 → 480 tick
  assert.equal(g[1]!.ticks[1]![0], 480);
  assert.ok(Math.abs(g[1]!.ticks[1]![1] - (524 + 158) / 2479) < 1e-6);
  // con trỏ nội suy giữa hai nốt
  const x = cursorX(g[1]!, 240, 1440);
  assert.ok(x > g[1]!.ticks[0]![1] && x < g[1]!.ticks[1]![1]);
  const r = regionOf(g.filter((m) => m.system === 0))!;
  assert.ok(r.x <= m0.x && r.w > 0.8);
});

test('MusicXML của Audiveris: dự phòng khi không có .omr; bản nhạc 9 ô, ô đầu lấy đà', () => {
  const xml = readFileSync(fx('audiveris-hymn.musicxml'), 'utf8');
  const g = extractSheetGeometry(xml)!;
  assert.equal(g.measures.length, 9);
  assert.equal(g.measures.filter((m) => m.system === 1)[0]!.measureIndex, 6);
  const s = importMusicXml(xml);
  assert.equal(s.measures.length, 9);
  assert.equal(specialNotation(s, 0), 'pickup');
  // Validator không báo thiếu phách cho ô lấy đà
  assert.ok(!validateMusic(s).some((i) => i.measureIndex === 0 && i.code === 'UNDERFULL'));
});

test('Validator: phát hiện ô thiếu/thừa phách, tự sửa an toàn nhưng không sửa ô đặc biệt', () => {
  const s = importMusicXml(readFileSync(fx('hymn-satb-vi.musicxml'), 'utf8'));
  assert.equal(validateMusic(s).filter((i) => i.severity === 'error').length, 0, 'bản chuẩn không có lỗi');
  // làm hỏng một ô giữa bài: xoá nốt cuối của bè đầu
  const k = s.measures.findIndex((mm, i) => i > 0 && i < s.measures.length - 1 && s.parts[0]!.content[mm.id]![0]!.events.length >= 2);
  const v = s.parts[0]!.content[s.measures[k]!.id]![0]!;
  v.events.pop();
  const issues = validateMusic(s);
  const u = issues.find((i) => i.code === 'UNDERFULL' && i.measureIndex === k)!;
  assert.ok(u && u.autoFix);
  autoFixIssues([u]).apply(s);
  assert.ok(!validateMusic(s).some((i) => i.code === 'UNDERFULL' && i.measureIndex === k));
  // thừa phách: không tự sửa (cần nhận dạng lại)
  v.events.push(JSON.parse(JSON.stringify(v.events[0])));
  const o = validateMusic(s).find((i) => i.code === 'OVERFULL' && i.measureIndex === k)!;
  assert.ok(o && !o.autoFix);
  // ô lấy đà: không tự sửa
  s.measures[0]!.pickup = true;
  for (const i of validateMusic(s).filter((x) => x.measureIndex === 0)) assert.equal(i.autoFix, false);
});

test('Validator: dấu nối hỏng được phát hiện', () => {
  const s = importMusicXml(readFileSync(fx('hymn-satb-vi.musicxml'), 'utf8'));
  const m = s.measures[1]!;
  const ev = s.parts[0]!.content[m.id]![0]!.events.find((e) => e.kind === 'chord')!;
  if (ev.kind === 'chord') ev.notes[0]!.tieStart = true;
  const tie = validateMusic(s).find((i) => i.code === 'TIE_BROKEN');
  assert.ok(tie && tie.measureIndex === 1);
});

test('tín hiệu vùng khó: điểm tin cậy theo ô và vùng đầu khuông nghi sót hoá biểu', () => {
  const xml = readFileSync(fx('audiveris-hymn.sheet.xml'), 'utf8');
  const g = extractOmrGeometry([xml])!;
  const sig = extractOmrSignals([xml], g);
  assert.ok(sig.grades.length >= 8);
  for (const x of sig.grades) assert.ok(x.min > 0 && x.min <= x.mean && x.mean <= 1);
  // bản gốc có 1 dấu giáng nhưng Audiveris không nhận ra: có vùng đầu khuông để kiểm tra mực
  assert.ok(sig.keyGaps.length >= 4);
  const k = sig.keyGaps[0]!;
  assert.ok(k.box.x > 249 / 2479 && k.box.x + k.box.w < 277 / 2479 + 1e-9);
  assert.equal(k.firstMeasure, 0);
});

test('áp dụng hoá biểu bị sót: Si thành Si giáng, trừ nốt có dấu hoá viết riêng', () => {
  const s = importMusicXml(readFileSync(fx('audiveris-hymn.musicxml'), 'utf8'));
  assert.equal(s.keyMap.length === 0 || s.keyMap[0]!.fifths === 0, true);
  const allNotes = () => s.parts.flatMap((p) => Object.values(p.content).flatMap((vs) => vs.flatMap((v) => v.events.flatMap((e) => (e.kind === 'chord' ? e.notes : [])))));
  const bs = allNotes().filter((n) => n.pitch.step === 'B' && !n.writtenAccidental);
  assert.ok(bs.length > 0);
  applyMissedKey(0, -1).apply(s);
  assert.equal(s.keyMap[0]!.fifths, -1);
  for (const n of allNotes()) if (n.pitch.step === 'B' && !n.writtenAccidental) assert.equal(n.pitch.alter, -1);
});

test('đầu nốt gắn đúng phách và khuông', () => {
  const g = extractOmrGeometry([readFileSync(fx('audiveris-hymn.sheet.xml'), 'utf8')])!;
  const m0 = g[0]!;
  // ô lấy đà: 4 bè × 1 nốt ở phách 0, mỗi khuông một nốt
  assert.equal(m0.heads!.length, 4);
  assert.deepEqual(m0.heads!.map((h) => h[0]), [0, 0, 0, 0]);
  assert.deepEqual([...new Set(m0.heads!.map((h) => h[1]))].sort(), [0, 1, 2, 3]);
  const h = m0.heads!.find((x) => x[1] === 0)!;
  assert.ok(Math.abs(h[2] - 403 / 2479) < 1e-6 && Math.abs(h[3] - 536 / 3508) < 1e-6);
  // ô 1: phách thứ 2 (480 tick) có đầu nốt
  assert.ok(g[1]!.heads!.some((x) => x[0] === 480));
});

test('ghép kết quả các trang nhận dạng song song', () => {
  const xml = readFileSync(fx('audiveris-hymn.musicxml'), 'utf8');
  const a = importMusicXml(xml);
  const b = importMusicXml(xml);
  const c = concatScores([a, b], [true, false])!;
  assert.equal(c.measures.length, a.measures.length * 2);
  assert.equal(c.timeSigMap.length, a.timeSigMap.length, 'trang 2 không thêm số chỉ nhịp');
  assert.ok(!c.measures[a.measures.length]!.pickup);
  const ids = new Set(c.measures.map((m) => m.id));
  assert.equal(ids.size, c.measures.length, 'id ô nhịp không trùng');
  assert.equal(hasExplicitTime(xml), true);
  const d = importMusicXml(xml); d.parts.pop();
  assert.equal(concatScores([a, d]), null);
});

void existsSync;
