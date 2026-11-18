import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSyllable, decodeWav, encodeWav, singSyllable, yinPitch, type PcmMono } from '../src/index.js';

/** Âm tiết tổng hợp: phụ âm (tiếng ồn) 60 ms + nguyên âm (xung thanh môn 190 Hz qua 2 formant) 0.5 s */
function syllable(sr = 24000): PcmMono {
  const n = Math.round(sr * 0.62);
  const x = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const cons = Math.round(sr * 0.06);
  for (let i = 0; i < cons; i++) x[i] = rnd() * 0.2;
  // xung → hai bộ cộng hưởng
  const res = (f: number, bw: number) => {
    const r = Math.exp((-Math.PI * bw) / sr);
    return { a1: 2 * r * Math.cos((2 * Math.PI * f) / sr), a2: -r * r, y1: 0, y2: 0 };
  };
  const f1 = res(700, 90);
  const f2 = res(1200, 110);
  let phase = 0;
  for (let i = cons; i < n - Math.round(sr * 0.02); i++) {
    phase += 190 / sr;
    const pulse = phase >= 1 ? 1 : 0;
    if (phase >= 1) phase -= 1;
    const y = pulse + f1.a1 * f1.y1 + f1.a2 * f1.y2;
    f1.y2 = f1.y1; f1.y1 = y;
    const z = y + f2.a1 * f2.y1 + f2.a2 * f2.y2;
    f2.y2 = f2.y1; f2.y1 = z;
    x[i] = z * 0.02;
  }
  return { sr, data: x };
}

test('giọng hát: đúng cao độ từng nốt, đúng độ dài; WAV đọc/ghi được', () => {
  const src = syllable();
  const an = analyzeSyllable(src);
  assert.ok(Math.abs(an.f0 - 190) < 6, `nhận ra cao độ nguồn ~190 Hz (được ${an.f0.toFixed(1)})`);
  assert.ok(an.voicedStart > src.sr * 0.04, 'tách được phụ âm đầu');
  const out = singSyllable(src, an, [{ t: 0, dur: 0.5, midi: 69 }, { t: 0.5, dur: 0.8, midi: 64 }], { vibrato: 0 });
  assert.equal(out.length, Math.round(1.3 * src.sr));
  const w = Math.round(src.sr * 0.04);
  const p1 = yinPitch(out, Math.round(src.sr * 0.3), w, src.sr);
  const p2 = yinPitch(out, Math.round(src.sr * 0.9), w, src.sr);
  assert.ok(Math.abs(p1 - 440) / 440 < 0.03, `nốt 1 ~440 Hz (được ${p1.toFixed(1)})`);
  assert.ok(Math.abs(p2 - 329.6) / 329.6 < 0.03, `nốt 2 ~330 Hz (được ${p2.toFixed(1)})`);
  // còn tiếng tới gần cuối (nguyên âm được kéo dài)
  let e = 0;
  for (let i = Math.round(src.sr * 1.1); i < Math.round(src.sr * 1.2); i++) e += out[i]! * out[i]!;
  assert.ok(e > 1e-4, 'nguyên âm được kéo dài đủ trường độ');
  const back = decodeWav(encodeWav([out], src.sr));
  assert.equal(back.data.length, out.length);
  assert.equal(back.sr, src.sr);
});

test('kế hoạch hát: âm tiết theo lời, nốt luyến kéo dài âm tiết trước, mượn lời cho bè không lời', async () => {
  const { buildScore } = await import('./helpers.js');
  const { singerPlan, CommandHistory, distributeLyrics, toggleSlur, ScoreIndex } = await import('../src/index.js');
  const s = buildScore([{ name: 'S', measures: ['C4:q D4:q E4:q F4:q'] }, { name: 'A', measures: ['A3:q B3:q C4:q D4:q'] }]);
  const h = new CommandHistory(s);
  const ids = new ScoreIndex(s).allNoteIds();
  const ev = (i: number) => new ScoreIndex(s).note(ids[i]!)!.event.id;
  h.execute(toggleSlur([ev(1), ev(2)]));
  h.execute(distributeLyrics({ partId: s.parts[0]!.id, verse: 1, text: 'Lạy Chúa, con' }));
  const p = singerPlan(s, { partId: s.parts[0]!.id, verse: 1 });
  assert.deepEqual(p.syllables.map((x) => [x.key, x.notes.length]), [['lạy', 1], ['chúa', 2], ['con', 1]]);
  const alto = singerPlan(s, { partId: s.parts[1]!.id, verse: 1, borrowFromPartId: s.parts[0]!.id });
  assert.deepEqual(alto.syllables.map((x) => x.key), ['lạy', 'chúa', 'con']);
  assert.equal(alto.syllables[1]!.notes.length, 2);
});
