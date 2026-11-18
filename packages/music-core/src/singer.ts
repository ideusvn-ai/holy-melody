/**
 * Kế hoạch hát cho AI Singer: từ bản nhạc → danh sách ÂM TIẾT, mỗi âm tiết gồm các nốt (giây) nó được hát trên.
 *  - nốt có lời → âm tiết mới; nốt không lời ngay sau (luyến/melisma) → kéo dài âm tiết trước;
 *  - dấu nối đã được gộp trong timeline;
 *  - hợp âm trong một bè → hát nốt cao nhất của voice 1;
 *  - bè không có lời (ca đoàn) có thể MƯỢN lời của bè giai điệu tại cùng thời điểm.
 */
import { ScoreIndex } from './score.js';
import { buildTimeline, tickToSeconds } from './timeline.js';
import type { ScoreDocument } from './model.js';

export interface SingNote {
  /** giây, tính từ đầu bài */
  start: number;
  dur: number;
  midi: number;
}

export interface SingSyllable {
  /** lời hiển thị */
  text: string;
  /** khoá âm tiết gửi máy chủ (chữ thường, bỏ dấu câu) */
  key: string;
  notes: SingNote[];
}

export interface SingPlan {
  syllables: SingSyllable[];
  /** số nốt không có lời (không hát) */
  silent: number;
  totalNotes: number;
  duration: number;
}

export const syllableKey = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}']+/gu, '');

export function singerPlan(score: ScoreDocument, o: { partId: string; verse: number; voiceNumber?: number; borrowFromPartId?: string; transpose?: number }): SingPlan {
  const tl = buildTimeline(score);
  const idx = new ScoreIndex(score);
  const voiceNo = o.voiceNumber ?? 1;
  type N = { tick: number; end: number; midi: number; lyric: string | null; slur: boolean };
  const collect = (partId: string): N[] => {
    const byTick = new Map<number, N>();
    for (const n of tl.notes) {
      if (n.partId !== partId) continue;
      const loc = idx.note(n.noteIds[0] ?? '');
      if (!loc || (loc.voice.number !== voiceNo && (loc.part.content[loc.measure.id]?.length ?? 1) > 1)) continue;
      const ev = loc.event;
      const lyr = ev.kind === 'chord' ? ev.lyrics.find((l) => l.verse === o.verse) ?? (o.verse > 1 ? undefined : ev.lyrics[0]) : undefined;
      const prev = byTick.get(n.tick);
      if (prev && prev.midi >= n.pitch) continue;
      byTick.set(n.tick, { tick: n.tick, end: n.tick + n.durationTicks, midi: n.pitch + (o.transpose ?? 0), lyric: lyr?.text.trim() || null, slur: ev.kind === 'chord' && !!ev.slurStop });
    }
    return [...byTick.values()].sort((a, b) => a.tick - b.tick);
  };
  const notes = collect(o.partId);
  const borrow = o.borrowFromPartId && o.borrowFromPartId !== o.partId ? new Map(collect(o.borrowFromPartId).filter((n) => n.lyric).map((n) => [n.tick, n.lyric!])) : null;
  const sec = (t: number) => tickToSeconds(tl, t);
  const out: SingSyllable[] = [];
  let silent = 0;
  let lastEnd = -1;
  for (const n of notes) {
    const text = n.lyric ?? borrow?.get(n.tick) ?? null;
    const note: SingNote = { start: sec(n.tick), dur: sec(n.end) - sec(n.tick), midi: n.midi };
    const key = text ? syllableKey(text) : '';
    if (key) {
      out.push({ text: text!, key, notes: [note] });
    } else if (out.length && lastEnd === n.tick) {
      out[out.length - 1]!.notes.push(note); // luyến: kéo dài âm tiết trước
    } else {
      silent++;
      lastEnd = -1;
      continue;
    }
    lastEnd = n.end;
  }
  return { syllables: out, silent, totalNotes: notes.length, duration: sec(tl.totalTicks) };
}
