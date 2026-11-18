import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScore, durationTicks, pitchFromStaffStep, placeNote, validateMusic } from '../src/index.ts';

const len = (evs: { duration: Parameters<typeof durationTicks>[0] }[]) => evs.reduce((a, e) => a + durationTicks(e.duration), 0);

test('bản mới: bấm vào dấu lặng là đặt được nốt, ô vẫn đủ phách', () => {
  const s = createScore({ measures: 2 });
  const p = s.parts[0]!;
  const m = s.measures[0]!;
  const cmd = placeNote({ partId: p.id, measureIndex: 0, voice: 1, staff: 0, tick: 480, pitch: { step: 'G', alter: 0, octave: 4 }, duration: { type: 'quarter', dots: 0 } });
  cmd.apply(s);
  const v = p.content[m.id]!.find((x) => x.number === 1)!;
  assert.equal(len(v.events), 1920);
  const kinds = v.events.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'chord').length, 1);
  assert.ok(cmd.result.noteId);
  // nốt ở phách 2
  let t = 0;
  for (const e of v.events) { if (e.kind === 'chord') break; t += durationTicks(e.duration); }
  assert.equal(t, 480);
  assert.equal(validateMusic(s).filter((i) => i.severity === 'error').length, 0);
});

test('ghi đè nốt trắng bằng nốt đen: nốt cũ bị rút ngắn, phần còn lại thành lặng', () => {
  const s = createScore({ measures: 1 });
  const p = s.parts[0]!;
  const opts = { partId: p.id, measureIndex: 0, voice: 1, staff: 0 };
  placeNote({ ...opts, tick: 0, pitch: { step: 'C', alter: 0, octave: 5 }, duration: { type: 'whole', dots: 0 } }).apply(s);
  placeNote({ ...opts, tick: 960, pitch: { step: 'E', alter: 0, octave: 5 }, duration: { type: 'quarter', dots: 0 } }).apply(s);
  const v = p.content[s.measures[0]!.id]![0]!;
  assert.equal(len(v.events), 1920);
  assert.deepEqual(v.events.map((e) => [e.kind, e.duration.type]), [['chord', 'half'], ['chord', 'quarter'], ['rest', 'quarter']]);
  // thêm nốt vào hợp âm
  placeNote({ ...opts, tick: 960, pitch: { step: 'G', alter: 0, octave: 5 }, duration: { type: 'quarter', dots: 0 }, addToChord: true }).apply(s);
  const c = v.events[1]!;
  assert.equal(c.kind === 'chord' && c.notes.length, 2);
});

test('nốt dài vượt ô: cắt theo phần còn lại; trường độ lẻ được chia + nối dây', () => {
  const s = createScore({ measures: 1 });
  const p = s.parts[0]!;
  placeNote({ partId: p.id, measureIndex: 0, voice: 1, staff: 0, tick: 1440, pitch: { step: 'A', alter: 0, octave: 4 }, duration: { type: 'whole', dots: 0 } }).apply(s);
  const v = p.content[s.measures[0]!.id]![0]!;
  assert.equal(len(v.events), 1920);
  const last = v.events[v.events.length - 1]!;
  assert.equal(last.kind === 'chord' && last.duration.type, 'quarter');
});

test('cao độ theo vị trí trên khuông + hoá biểu', () => {
  assert.deepEqual(pitchFromStaffStep({ sign: 'G', line: 2 }, 0, 0), { step: 'E', octave: 4, alter: 0 });
  assert.deepEqual(pitchFromStaffStep({ sign: 'G', line: 2 }, 4, 1), { step: 'B', octave: 4, alter: 0 });
  assert.deepEqual(pitchFromStaffStep({ sign: 'G', line: 2 }, 3, -1), { step: 'A', octave: 4, alter: 0 });
  assert.deepEqual(pitchFromStaffStep({ sign: 'G', line: 2 }, 5, -1), { step: 'C', octave: 5, alter: 0 });
  assert.deepEqual(pitchFromStaffStep({ sign: 'G', line: 2 }, 6, 1), { step: 'D', octave: 5, alter: 0 });
  assert.deepEqual(pitchFromStaffStep({ sign: 'G', line: 2 }, 7, 1), { step: 'E', octave: 5, alter: 0 });
  assert.deepEqual(pitchFromStaffStep({ sign: 'G', line: 2 }, 8, 1), { step: 'F', octave: 5, alter: 1 });
  assert.deepEqual(pitchFromStaffStep({ sign: 'F', line: 4 }, 0, -1), { step: 'G', octave: 2, alter: 0 });
  assert.deepEqual(pitchFromStaffStep({ sign: 'F', line: 4 }, 2, -1), { step: 'B', octave: 2, alter: -1 });
});
