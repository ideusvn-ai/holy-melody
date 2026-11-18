/**
 * Lời ca thông minh: dán cả đoạn lời → tự tách âm tiết và gán vào từng nốt.
 *
 * Quy ước gõ lời (giống các phần mềm ký âm):
 *   - Khoảng trắng: sang nốt kế tiếp. Tiếng Việt: mỗi chữ là một âm tiết.
 *   - Dấu "-" trong một từ: tách âm tiết đa âm (Hal-le-lu-jah, A-men).
 *   - Dấu "_" đứng riêng: ngân âm tiết trước sang nốt tiếp theo (melisma).
 * Tự động bỏ qua: nốt nối tiếp (tie), nốt hoa mỹ, các nốt bên trong dấu luyến (melisma).
 */
import type { Command } from './history.js';
import { newId } from './ids.js';
import type { ChordEvent, LayoutSettings, Lyric, ScoreDocument, Syllabic } from './model.js';
import { ScoreIndex } from './score.js';

export interface LyricToken {
  text: string;
  syllabic: Syllabic;
  /** "_" → giữ âm tiết trước */
  hold?: boolean;
}

export function tokenizeLyrics(text: string): LyricToken[] {
  const out: LyricToken[] = [];
  for (const word of text.normalize('NFC').replace(/\r/g, '').split(/\s+/).filter(Boolean)) {
    if (/^_+$/.test(word)) {
      for (let i = 0; i < word.length; i++) out.push({ text: '', syllabic: 'single', hold: true });
      continue;
    }
    // "--" hoặc "-" đầu/cuối đều coi là ngắt âm tiết; giữ dấu câu ở âm tiết cuối
    const parts = word.split(/-+/).filter((p) => p.length);
    if (parts.length <= 1) {
      out.push({ text: parts[0] ?? word, syllabic: 'single' });
      continue;
    }
    parts.forEach((p, i) => out.push({ text: p, syllabic: i === 0 ? 'begin' : i === parts.length - 1 ? 'end' : 'middle' }));
  }
  return out;
}

/** Các event nhận lời theo thứ tự (bỏ qua nối, hoa mỹ, nốt giữa dấu luyến) */
function lyricTargets(score: ScoreDocument, partId: string, voiceNumber: number) {
  const part = score.parts.find((p) => p.id === partId);
  if (!part) throw new Error('Không tìm thấy bè');
  const out: { event: ChordEvent; inSlur: boolean }[] = [];
  let slurOpen = false;
  for (const m of score.measures) {
    const v = (part.content[m.id] ?? []).find((x) => x.number === voiceNumber) ?? (part.content[m.id] ?? [])[0];
    for (const e of v?.events ?? []) {
      if (e.kind !== 'chord' || e.grace) continue;
      const tieCont = e.notes.length > 0 && e.notes.every((n) => n.tieStop);
      if (!tieCont) out.push({ event: e, inSlur: slurOpen && !e.slurStart });
      if (e.slurStart) slurOpen = true;
      if (e.slurStop) slurOpen = false;
    }
  }
  return out;
}

export interface DistributeOptions {
  partId: string;
  verse: number;
  text: string;
  /** Bắt đầu từ event này (mặc định nốt đầu tiên) */
  startEventId?: string;
  voiceNumber?: number;
  /** Nốt nằm giữa dấu luyến nhận cùng âm tiết (melisma) — mặc định true */
  respectSlurs?: boolean;
  /** Chỉ phân bổ (và chỉ xoá lời cũ) trong các ô này — vd một dòng nhạc; âm tiết thừa bị bỏ */
  measures?: number[];
}

function rangeFilter(score: ScoreDocument, o: DistributeOptions): ((id: string) => boolean) {
  if (!o.measures) return () => true;
  const ids = new Set(lyricTargetsIn(score, o.partId, o.measures, o.voiceNumber ?? 1).map((e) => e.id));
  return (id) => ids.has(id);
}

export interface DistributeReport {
  syllables: number;
  notesUsed: number;
  /** số âm tiết còn dư khi hết nốt */
  leftoverSyllables: number;
  /** số nốt còn lại không có lời trong phạm vi phân bổ */
  notesWithoutLyrics: number;
}

/** Các nốt nhận lời (bỏ dấu lặng, nốt nối, nốt hoa mỹ) của bè `partId` trong các ô `measureIndices` */
export function lyricTargetsIn(score: ScoreDocument, partId: string, measureIndices: number[], voiceNumber = 1): ChordEvent[] {
  const ids = new Set(measureIndices.map((i) => score.measures[i]?.id));
  const inRange = new Set<string>();
  const part = score.parts.find((p) => p.id === partId);
  for (const id of ids) {
    if (!id || !part) continue;
    const v = (part.content[id] ?? []).find((x) => x.number === voiceNumber) ?? (part.content[id] ?? [])[0];
    for (const e of v?.events ?? []) inRange.add(e.id);
  }
  return lyricTargets(score, partId, voiceNumber).filter((t) => inRange.has(t.event.id)).map((t) => t.event);
}

/** Xem trước kết quả mà không thay đổi bản nhạc */
export function planLyrics(score: ScoreDocument, o: DistributeOptions) {
  const tokens = tokenizeLyrics(o.text);
  let targets = lyricTargets(score, o.partId, o.voiceNumber ?? 1);
  if (o.startEventId) {
    const i = targets.findIndex((t) => t.event.id === o.startEventId);
    if (i < 0) throw new Error('Nốt bắt đầu không nhận lời (dấu lặng, nốt nối hoặc nốt hoa mỹ)');
    targets = targets.slice(i);
  }
  const inRange = rangeFilter(score, o);
  targets = targets.filter((t) => inRange(t.event.id));
  const respect = o.respectSlurs ?? true;
  const plan: { eventId: string; lyric: Omit<Lyric, 'id'> | null }[] = [];
  let ti = 0;
  let lastWithText: { eventId: string; lyric: Omit<Lyric, 'id'> } | undefined;
  for (const t of targets) {
    if (ti >= tokens.length) break;
    if (respect && t.inSlur && lastWithText) {
      lastWithText.lyric.extend = true;
      plan.push({ eventId: t.event.id, lyric: null });
      continue;
    }
    const tok = tokens[ti++]!;
    if (tok.hold) {
      if (lastWithText) lastWithText.lyric.extend = true;
      plan.push({ eventId: t.event.id, lyric: null });
      continue;
    }
    const entry = { eventId: t.event.id, lyric: { verse: o.verse, text: tok.text, syllabic: tok.syllabic } as Omit<Lyric, 'id'> };
    plan.push(entry);
    lastWithText = entry;
  }
  const report: DistributeReport = {
    syllables: tokens.filter((t) => !t.hold).length,
    notesUsed: plan.length,
    leftoverSyllables: tokens.length - ti,
    notesWithoutLyrics: Math.max(0, targets.length - plan.length),
  };
  return { plan, report };
}

/** Phân bổ cả đoạn lời vào nốt (một bước Undo). Lời cũ của cùng phiên khúc trong phạm vi được thay thế. */
export const distributeLyrics = (o: DistributeOptions): Command => ({
  label: `Phân bổ lời ${o.verse}`,
  scope: () => ({ kind: 'all' }),
  apply: (s) => {
    const { plan } = planLyrics(s, o);
    const targets = lyricTargets(s, o.partId, o.voiceNumber ?? 1);
    const startIdx = o.startEventId ? targets.findIndex((t) => t.event.id === o.startEventId) : 0;
    // xóa lời cùng phiên khúc từ điểm bắt đầu tới hết (để không còn chữ cũ lẫn vào)
    const inRange = rangeFilter(s, o);
    for (const t of targets.slice(Math.max(0, startIdx))) if (inRange(t.event.id)) t.event.lyrics = t.event.lyrics.filter((l) => l.verse !== o.verse);
    // nốt nối/nốt giữa luyến cũng xóa lời cũ của phiên khúc này
    const idx = new ScoreIndex(s);
    for (const p of plan) {
      const ev = idx.event(p.eventId)?.event as ChordEvent | undefined;
      if (!ev) continue;
      ev.lyrics = ev.lyrics.filter((l) => l.verse !== o.verse);
      if (p.lyric) ev.lyrics.push({ id: newId('l'), ...p.lyric });
      ev.lyrics.sort((a, b) => a.verse - b.verse);
    }
  },
});

/** Ghép lời hiện có thành văn bản để chỉnh sửa (ngược với distributeLyrics) */
export function lyricsToText(score: ScoreDocument, partId: string, verse: number, voiceNumber = 1): string {
  const out: string[] = [];
  for (const t of lyricTargets(score, partId, voiceNumber)) {
    const l = t.event.lyrics.find((x) => x.verse === verse);
    if (!l) {
      if (out.length && !t.inSlur) out.push('_');
      continue;
    }
    if (l.syllabic === 'middle' || l.syllabic === 'end') out[out.length - 1] += `-${l.text}`;
    else out.push(l.text);
  }
  while (out[out.length - 1] === '_') out.pop();
  return out.join(' ');
}

/** Các phiên khúc đang có trong bè */
export function versesOf(score: ScoreDocument, partId: string): number[] {
  const set = new Set<number>();
  const part = score.parts.find((p) => p.id === partId);
  for (const vs of Object.values(part?.content ?? {})) for (const v of vs) for (const e of v.events) if (e.kind === 'chord') for (const l of e.lyrics) set.add(l.verse);
  return [...set].sort((a, b) => a - b);
}

/** Đổi kiểu chữ / cỡ / vị trí lời ca cho toàn bài */
export const setLyricStyle = (patch: Partial<Pick<LayoutSettings, 'lyricFont' | 'lyricFontSizePt' | 'lyricOffsetSp' | 'lyricVerseSpacingSp' | 'showVerseNumbers' | 'lyricItalicVerses'>>): Command => ({
  label: 'Định dạng lời ca',
  scope: () => ({ kind: 'all' }),
  apply: (s) => {
    if (patch.lyricFontSizePt !== undefined && (patch.lyricFontSizePt < 6 || patch.lyricFontSizePt > 24)) throw new Error('Cỡ chữ lời ca từ 6 đến 24 pt');
    Object.assign(s.layout, patch);
  },
});

/** Dịch ngang một âm tiết (đơn vị: khoảng dòng kẻ); dx = 0 để đặt lại */
export const nudgeLyric = (eventId: string, verse: number, dx: number): Command => ({
  label: 'Dịch chữ lời ca',
  scope: (s) => {
    const loc = new ScoreIndex(s).event(eventId);
    if (!loc) throw new Error('Không tìm thấy nốt');
    return { kind: 'cells', cells: [{ partId: loc.part.id, measureId: loc.measure.id }] };
  },
  apply: (s) => {
    const ev = new ScoreIndex(s).event(eventId)!.event;
    const l = ev.kind === 'chord' ? ev.lyrics.find((x) => x.verse === verse) : undefined;
    if (!l) throw new Error('Nốt này chưa có lời ở phiên khúc đã chọn');
    l.offsetX = dx === 0 ? undefined : Math.round(((l.offsetX ?? 0) + dx) * 10) / 10;
  },
});

/**
 * Dời lời từ một nốt trở về sau đi MỘT nốt (cả đoạn phía sau dời theo).
 *  - direction +1 (đẩy tới): nốt đang chọn thành trống, mỗi âm tiết sang nốt kế tiếp. Cần nốt cuối còn trống.
 *  - direction −1 (lùi lại): mỗi âm tiết sang nốt trước; nốt ngay trước điểm chọn phải đang trống.
 * Chỉ tính nốt nhận lời (bỏ dấu lặng, nốt nối, nốt hoa mỹ). Một bước Undo.
 */
export function shiftLyrics(o: { partId: string; verse: number; fromEventId: string; direction: 1 | -1; voiceNumber?: number }): Command {
  return {
    label: o.direction > 0 ? 'Đẩy lời sang nốt sau' : 'Lùi lời về nốt trước',
    scope: () => ({ kind: 'all' }),
    apply: (s) => {
      const targets = lyricTargets(s, o.partId, o.voiceNumber ?? 1);
      const i = targets.findIndex((t) => t.event.id === o.fromEventId);
      if (i < 0) throw new Error('Nốt đang chọn không nhận lời (dấu lặng, nốt nối hoặc nốt hoa mỹ)');
      const take = (k: number) => {
        const ev = targets[k]!.event;
        const l = ev.lyrics.find((x) => x.verse === o.verse) ?? null;
        ev.lyrics = ev.lyrics.filter((x) => x.verse !== o.verse);
        return l;
      };
      const put = (k: number, l: Lyric | null) => {
        if (!l) return;
        const ev = targets[k]!.event;
        const { offsetX: _drop, ...rest } = l;
        void _drop;
        ev.lyrics.push(rest);
        ev.lyrics.sort((a, b) => a.verse - b.verse);
      };
      const has = (k: number) => targets[k]!.event.lyrics.some((x) => x.verse === o.verse);
      // phạm vi: từ i tới âm tiết cuối cùng của lời này
      let last = targets.length - 1;
      while (last >= i && !has(last)) last--;
      if (last < i) throw new Error('Không có lời nào từ nốt này trở về sau');
      if (o.direction > 0) {
        if (last + 1 >= targets.length) throw new Error('Hết nốt để đẩy lời tới — âm tiết cuối đã ở nốt cuối cùng');
        for (let k = last; k >= i; k--) put(k + 1, take(k));
      } else {
        if (i === 0) throw new Error('Đã ở nốt đầu tiên');
        if (has(i - 1)) throw new Error('Nốt trước đã có lời — xoá âm tiết đó trước khi lùi');
        for (let k = i; k <= last; k++) put(k - 1, take(k));
      }
    },
  };
}
