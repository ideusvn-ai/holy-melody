import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandHistory, distributeLyrics, exportMusicXml, importMusicXml, lyricsToText, nudgeLyric, planLyrics, ScoreIndex, setLyricStyle,
  toggleSlur, toggleTie, tokenizeLyrics, versesOf, type ChordEvent,
} from '../src/index.js';
import { buildScore } from './helpers.js';

test('tách âm tiết: tiếng Việt theo chữ, "-" cho từ đa âm, "_" ngân', () => {
  assert.deepEqual(tokenizeLyrics('Hal-le-lu-jah Chúa _ ơi').map((t) => [t.text, t.syllabic, !!t.hold]), [
    ['Hal', 'begin', false], ['le', 'middle', false], ['lu', 'middle', false], ['jah', 'end', false],
    ['Chúa', 'single', false], ['', 'single', true], ['ơi', 'single', false],
  ]);
  assert.equal(tokenizeLyrics('Chúa')[0]!.text, 'Chúa', 'chuẩn hóa NFC');
});

test('phân bổ cả câu vào nốt, bỏ qua nốt nối và nốt trong dấu luyến; báo thừa/thiếu', () => {
  const s = buildScore([{ name: 'S', measures: ['C4:q D4:q E4:q F4:q', 'G4:q G4:q A4:q B4:q', 'C5:w'] }]);
  const h = new CommandHistory(s);
  const ids = new ScoreIndex(s).allNoteIds();
  const ev = (i: number) => new ScoreIndex(s).note(ids[i]!)!;
  h.execute(toggleTie(ev(4).note.id)); // G4 – G4 nối
  h.execute(toggleSlur([ev(6).event.id, ev(7).event.id])); // A4–B4 luyến
  const plan = planLyrics(s, { partId: s.parts[0]!.id, verse: 1, text: 'Xin Chúa thương xót con đây ơi Amen thêm' });
  h.execute(distributeLyrics({ partId: s.parts[0]!.id, verse: 1, text: 'Xin Chúa thương xót con đây ơi Amen thêm' }));
  const texts = ids.map((id) => (new ScoreIndex(s).note(id)!.event as ChordEvent).lyrics[0]?.text ?? '·');
  assert.deepEqual(texts, ['Xin', 'Chúa', 'thương', 'xót', 'con', '·', 'đây', '·', 'ơi']);
  const a4 = new ScoreIndex(s).note(ids[6]!)!.event as ChordEvent;
  assert.ok(a4.lyrics[0]!.extend, 'âm tiết đầu dấu luyến có gạch ngân');
  assert.equal(plan.report.leftoverSyllables, 2, 'thừa "Amen thêm"');
  assert.equal(lyricsToText(s, s.parts[0]!.id, 1), 'Xin Chúa thương xót con đây ơi');
  h.undo();
  assert.equal(versesOf(s, s.parts[0]!.id).length, 0);
});

test('nhiều phiên khúc, bắt đầu từ nốt chọn, giữ lời phiên khúc khác', () => {
  const s = buildScore([{ name: 'S', measures: ['C4:q D4:q E4:q F4:q'] }]);
  const p = s.parts[0]!.id;
  const h = new CommandHistory(s);
  h.execute(distributeLyrics({ partId: p, verse: 1, text: 'một hai ba bốn' }));
  const ids = new ScoreIndex(s).allNoteIds().map((id) => new ScoreIndex(s).note(id)!.event.id);
  h.execute(distributeLyrics({ partId: p, verse: 2, text: 'năm sáu', startEventId: ids[2] }));
  assert.deepEqual(versesOf(s, p), [1, 2]);
  assert.equal(lyricsToText(s, p, 1), 'một hai ba bốn');
  assert.equal(lyricsToText(s, p, 2), 'năm sáu');
  const back = importMusicXml(exportMusicXml(s));
  assert.equal(lyricsToText(back, back.parts[0]!.id, 2), 'năm sáu');
});

test('kiểu chữ, cỡ chữ, vị trí lời ca và dịch từng âm tiết – lưu qua MusicXML', () => {
  const s = buildScore([{ name: 'S', measures: ['C4:h D4:h'] }]);
  const h = new CommandHistory(s);
  h.execute(distributeLyrics({ partId: s.parts[0]!.id, verse: 1, text: 'A-men' }));
  h.execute(setLyricStyle({ lyricFont: 'Times New Roman', lyricFontSizePt: 12, lyricOffsetSp: 4 }));
  const e0 = new ScoreIndex(s).event(s.parts[0]!.content[s.measures[0]!.id]![0]!.events[0]!.id)!.event.id;
  h.execute(nudgeLyric(e0, 1, 0.5));
  h.execute(nudgeLyric(e0, 1, 0.3));
  const back = importMusicXml(exportMusicXml(s));
  assert.equal(back.layout.lyricFont, 'Times New Roman');
  assert.equal(back.layout.lyricFontSizePt, 12);
  const l = (back.parts[0]!.content[back.measures[0]!.id]![0]!.events[0] as ChordEvent).lyrics[0]!;
  assert.equal(l.offsetX, 0.8);
  assert.equal(l.syllabic, 'begin');
  assert.throws(() => h.execute(setLyricStyle({ lyricFontSizePt: 40 })));
  h.undo(); h.undo(); h.undo();
  assert.equal(s.layout.lyricFont, 'Noto Serif');
});
