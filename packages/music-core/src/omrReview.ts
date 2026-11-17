/**
 * Hiệu chỉnh kết quả OMR — 3 cơ chế:
 *  1. Music Rule Validator: kiểm tra trường độ ô nhịp, dấu hoá, dấu nối, phân bè, cấu trúc không hợp lệ.
 *     Chỉ tự sửa những lỗi an toàn; KHÔNG tự sửa ô có lấy đà (pickup), cadenza hoặc cách ký âm đặc biệt.
 *  2. Region Re-recognition: `replaceMeasuresFrom` thay đúng những ô nhịp lỗi bằng kết quả nhận dạng lại vùng đó.
 *  3. Human-in-the-loop: `recordReview` lưu kết quả đối chiếu + tọa độ vùng ảnh vĩnh viễn trong dự án.
 */
import { durationTicks } from './duration.js';
import type { Command } from './history.js';
import type { MeasureReview, MusicEvent, ScoreDocument, SheetSource, Voice } from './model.js';
import { keyAt, measureTicks, nominalMeasureTicks, timeSigAt } from './score.js';
import { newId } from './ids.js';

export type RuleCode =
  | 'UNDERFULL' | 'OVERFULL' | 'TIE_BROKEN' | 'TIE_ORPHAN' | 'ACCIDENTAL_UNUSUAL' | 'ACCIDENTAL_DENSE'
  | 'VOICE_STAFF' | 'PART_MISSING' | 'DUP_PITCH' | 'EMPTY_CHORD' | 'RANGE' | 'TUPLET_INCOMPLETE' | 'LOW_CONFIDENCE'
  | 'KEY_SUSPECT' | 'LOW_GRADE';

export type SpecialNotation = 'pickup' | 'cadenza' | 'irregular';

export interface RuleIssue {
  code: RuleCode;
  severity: 'error' | 'warning';
  measureIndex: number;
  measureId: string;
  partId?: string;
  elementId?: string;
  message: string;
  /** Ô nhịp có cách ký âm đặc biệt: chỉ báo, không tự sửa */
  special?: SpecialNotation;
  /** Có thể tự sửa an toàn */
  autoFix: boolean;
}

const TQ = 480;

/** Nhận biết ô lấy đà / cadenza / ký âm đặc biệt (không được tự sửa) */
export function specialNotation(score: ScoreDocument, mi: number): SpecialNotation | undefined {
  const m = score.measures[mi];
  if (!m) return undefined;
  const nominal = nominalMeasureTicks(score, mi);
  const lens: number[] = [];
  let graces = 0;
  let small = 0;
  let oddTuplet = false;
  for (const part of score.parts) {
    for (const v of part.content[m.id] ?? []) {
      let t = 0;
      for (const e of v.events) {
        if (e.kind === 'chord' && e.grace) { graces++; continue; }
        if (e.kind === 'rest' && e.measureRest) { t = nominal; continue; }
        t += durationTicks(e.duration);
        if (e.duration.type === '16th' || e.duration.type === '32nd' || e.duration.type === '64th') small++;
        const tu = e.duration.tuplet;
        if (tu && ![3, 5, 6, 7].includes(tu.actual)) oddTuplet = true;
      }
      if (v.events.some((e) => !(e.kind === 'rest' && e.hidden))) lens.push(t);
    }
  }
  const max = Math.max(0, ...lens);
  if (m.pickup) return 'pickup';
  if (mi === 0 && max > 0 && max < nominal) return 'pickup';
  // ô cuối bù cho ô lấy đà đầu bài
  if (mi === score.measures.length - 1 && mi > 0 && max < nominal) {
    const firstLen = score.measures[0]!.actualTicks ?? 0;
    if (score.measures[0]!.pickup || (firstLen && firstLen + max === nominal)) return 'pickup';
  }
  if (max > nominal * 1.75 && small >= 8) return 'cadenza';
  if (graces >= 4) return 'cadenza';
  if (m.barlineRight === 'dashed' || m.barlineRight === 'none' || oddTuplet) return 'irregular';
  return undefined;
}

function voiceLen(score: ScoreDocument, mi: number, v: Voice): number {
  let t = 0;
  for (const e of v.events) {
    if (e.kind === 'chord' && e.grace) continue;
    if (e.kind === 'rest' && e.measureRest) return measureTicks(score, mi);
    t += durationTicks(e.duration);
  }
  return t;
}

const pitchKey = (p: { step: string; alter: number; octave: number }) => `${p.step}${p.alter}${p.octave}`;
const midiOf = (p: { step: string; alter: number; octave: number }) =>
  12 * (p.octave + 1) + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[p.step]! + p.alter;

/** Kiểm tra quy tắc âm nhạc. `measures`: chỉ kiểm tra các ô này (mặc định: cả bài) */
export function validateMusic(score: ScoreDocument, opts: { measures?: number[]; confidenceBelow?: number } = {}): RuleIssue[] {
  const out: RuleIssue[] = [];
  const list = opts.measures ?? score.measures.map((_, i) => i);
  for (const mi of list) {
    const m = score.measures[mi];
    if (!m) continue;
    const special = specialNotation(score, mi);
    const expected = special === 'pickup' && m.actualTicks ? m.actualTicks : nominalMeasureTicks(score, mi);
    const ts = timeSigAt(score, mi);
    const key = keyAt(score, mi);
    const push = (i: Omit<RuleIssue, 'measureIndex' | 'measureId' | 'special'>) =>
      out.push({ ...i, measureIndex: mi, measureId: m.id, special, autoFix: i.autoFix && !special });

    const partsWithContent = score.parts.filter((p) => (p.content[m.id] ?? []).some((v) => v.events.length));
    if (partsWithContent.length && partsWithContent.length < score.parts.length) {
      for (const p of score.parts) if (!partsWithContent.includes(p)) push({ code: 'PART_MISSING', severity: 'warning', partId: p.id, message: `Bè "${p.name}" không có nốt nào ở ô ${m.number}: có thể nhận dạng sót`, autoFix: false });
    }

    for (const part of score.parts) {
      const voices = part.content[m.id] ?? [];
      for (const v of voices) {
        if (!v.events.length || v.events.every((e) => e.kind === 'rest' && e.hidden)) continue;
        // ---- trường độ
        const len = voiceLen(score, mi, v);
        if (special !== 'pickup' && special !== 'cadenza') {
          if (len < expected) push({ code: 'UNDERFULL', severity: 'error', partId: part.id, elementId: v.id, message: `Ô ${m.number} (${part.name}, bè ${v.number}) thiếu ${fmtBeats(expected - len, ts.beatType)} so với nhịp ${ts.beats}/${ts.beatType}`, autoFix: true });
          if (len > expected) push({ code: 'OVERFULL', severity: 'error', partId: part.id, elementId: v.id, message: `Ô ${m.number} (${part.name}, bè ${v.number}) thừa ${fmtBeats(len - expected, ts.beatType)} so với nhịp ${ts.beats}/${ts.beatType}`, autoFix: false });
        } else if (special === 'pickup' && len > nominalMeasureTicks(score, mi)) {
          push({ code: 'OVERFULL', severity: 'error', partId: part.id, elementId: v.id, message: `Ô lấy đà ${m.number} dài hơn cả một ô nhịp đầy đủ`, autoFix: false });
        }
        // ---- liên ba / liên năm chưa đủ nhóm
        let run = 0;
        for (const e of [...v.events, null]) {
          if (e && e.duration.tuplet && !(e.kind === 'chord' && e.grace)) run += durationTicks(e.duration);
          else {
            if (run && run % 60 !== 0) push({ code: 'TUPLET_INCOMPLETE', severity: 'warning', partId: part.id, elementId: v.id, message: `Nhóm liên âm ở ô ${m.number} chưa đủ nốt`, autoFix: false });
            run = 0;
          }
        }
        // ---- từng nốt
        const foreign = new Set<string>();
        v.events.forEach((e, ei) => {
          if (e.staff >= Math.max(1, part.staves.length)) push({ code: 'VOICE_STAFF', severity: 'error', partId: part.id, elementId: e.id, message: `Nốt ở ô ${m.number} nằm trên khuông không tồn tại`, autoFix: false });
          if (e.kind !== 'chord') return;
          if (!e.notes.length) { push({ code: 'EMPTY_CHORD', severity: 'error', partId: part.id, elementId: e.id, message: `Hợp âm rỗng ở ô ${m.number}`, autoFix: true }); return; }
          const seen = new Set<string>();
          for (const n of e.notes) {
            const k = pitchKey(n.pitch);
            if (seen.has(k)) push({ code: 'DUP_PITCH', severity: 'warning', partId: part.id, elementId: n.id, message: `Nốt trùng cao độ trong một hợp âm ở ô ${m.number}`, autoFix: true });
            seen.add(k);
            const midi = midiOf(n.pitch);
            if (midi < 21 || midi > 108) push({ code: 'RANGE', severity: 'error', partId: part.id, elementId: n.id, message: `Cao độ ngoài phạm vi đàn piano ở ô ${m.number}: có thể đọc sai khoá nhạc`, autoFix: false });
            if (Math.abs(n.pitch.alter) === 2 && Math.abs(key.fifths) <= 3) push({ code: 'ACCIDENTAL_UNUSUAL', severity: 'warning', partId: part.id, elementId: n.id, message: `Dấu thăng/giáng kép ở ô ${m.number} hiếm gặp trong giọng này: có thể nhận dạng nhầm`, autoFix: false });
            if (n.pitch.alter !== keyAlter(key.fifths, n.pitch.step)) foreign.add(`${n.pitch.step}${n.pitch.alter}`);
            if (n.omrConfidence !== undefined && n.omrConfidence < (opts.confidenceBelow ?? 0.5)) push({ code: 'LOW_CONFIDENCE', severity: 'warning', partId: part.id, elementId: n.id, message: `Nốt nhận dạng với độ tin cậy thấp ở ô ${m.number}`, autoFix: false });
            // ---- dấu nối
            if (n.tieStart) {
              const next = nextEvent(score, part.id, mi, v.number, ei);
              const ok = next?.kind === 'chord' && next.notes.some((x) => midiOf(x.pitch) === midi);
              if (!ok) push({ code: 'TIE_BROKEN', severity: 'warning', partId: part.id, elementId: n.id, message: `Dấu nối ở ô ${m.number} không nối tới nốt cùng cao độ`, autoFix: true });
            }
            if (n.tieStop) {
              const prev = prevEvent(score, part.id, mi, v.number, ei);
              const ok = prev?.kind === 'chord' && prev.notes.some((x) => x.tieStart && midiOf(x.pitch) === midi);
              if (!ok) push({ code: 'TIE_ORPHAN', severity: 'warning', partId: part.id, elementId: n.id, message: `Cuối dấu nối ở ô ${m.number} không có điểm bắt đầu`, autoFix: true });
            }
          }
        });
        if (foreign.size >= 3) push({ code: 'ACCIDENTAL_DENSE', severity: 'warning', partId: part.id, elementId: v.id, message: `Ô ${m.number} có ${foreign.size} dấu hoá ngoài giọng: kiểm tra lại dấu hoá và hoá biểu`, autoFix: false });
      }
    }
  }
  return out;
}

/** Vùng khó do bước phát hiện (sheet.signals) — bỏ qua các ô người dùng đã xác nhận */
export function signalIssues(score: ScoreDocument): RuleIssue[] {
  const sh = score.sheet;
  if (!sh?.signals) return [];
  const out: RuleIssue[] = [];
  for (const s of sh.signals) {
    const m = score.measures[s.measureIndex];
    if (!m) continue;
    const r = sh.reviews[m.id];
    if (r && r.status !== 'flagged') continue;
    out.push({ code: s.code, severity: s.code === 'KEY_SUSPECT' ? 'error' : 'warning', measureIndex: s.measureIndex, measureId: m.id, message: s.message, autoFix: false });
  }
  return out;
}

/** Toàn bộ vấn đề cần đối chiếu: quy tắc âm nhạc + vùng khó phát hiện từ ảnh */
export const reviewIssues = (score: ScoreDocument): RuleIssue[] => [...validateMusic(score), ...signalIssues(score)];

function keyAlter(fifths: number, step: string): number {
  const sharps = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flats = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0 && sharps.slice(0, fifths).includes(step)) return 1;
  if (fifths < 0 && flats.slice(0, -fifths).includes(step)) return -1;
  return 0;
}

function fmtBeats(ticks: number, beatType: number): string {
  const beats = ticks / ((TQ * 4) / beatType);
  return `${Number.isInteger(beats) ? beats : beats.toFixed(2).replace(/0+$/, '')} phách`;
}

function voiceAt(score: ScoreDocument, partId: string, mi: number, num: number): Voice | undefined {
  const p = score.parts.find((x) => x.id === partId);
  const m = score.measures[mi];
  return p && m ? (p.content[m.id] ?? []).find((v) => v.number === num) : undefined;
}
function nextEvent(score: ScoreDocument, partId: string, mi: number, vnum: number, ei: number): MusicEvent | undefined {
  const v = voiceAt(score, partId, mi, vnum);
  const after = v?.events.slice(ei + 1).find((e) => !(e.kind === 'chord' && e.grace));
  if (after) return after;
  return voiceAt(score, partId, mi + 1, vnum)?.events.find((e) => !(e.kind === 'chord' && e.grace));
}
function prevEvent(score: ScoreDocument, partId: string, mi: number, vnum: number, ei: number): MusicEvent | undefined {
  const v = voiceAt(score, partId, mi, vnum);
  const before = v?.events.slice(0, ei).reverse().find((e) => !(e.kind === 'chord' && e.grace));
  if (before) return before;
  const pv = voiceAt(score, partId, mi - 1, vnum);
  return pv ? [...pv.events].reverse().find((e) => !(e.kind === 'chord' && e.grace)) : undefined;
}

/** Điểm "khó" của từng ô nhịp (0 = ổn): dùng để chọn vùng cần nhận dạng lại */
export function difficulty(issues: RuleIssue[]): Map<number, number> {
  const d = new Map<number, number>();
  for (const i of issues) d.set(i.measureIndex, (d.get(i.measureIndex) ?? 0) + (i.severity === 'error' ? 3 : 1));
  return d;
}

const ALL = { kind: 'all' as const };

/** Tự sửa các lỗi an toàn (bỏ qua ô đặc biệt). Ô thiếu phách được bù dấu lặng ở cuối để vẫn phát đúng nhịp. */
export const autoFixIssues = (issues: RuleIssue[]): Command => ({
  label: 'Tự sửa lỗi nhận dạng an toàn',
  scope: () => ALL,
  apply: (s) => {
    for (const i of issues) {
      if (!i.autoFix || i.special) continue;
      const part = s.parts.find((p) => p.id === i.partId);
      const m = s.measures[i.measureIndex];
      if (!part || !m) continue;
      const voices = part.content[m.id] ?? [];
      if (i.code === 'UNDERFULL') {
        const v = voices.find((x) => x.id === i.elementId);
        if (!v) continue;
        const missing = nominalMeasureTicks(s, i.measureIndex) - voiceLen(s, i.measureIndex, v);
        const staff = v.events[v.events.length - 1]?.staff ?? 0;
        for (const d of restFill(missing)) v.events.push({ id: newId('e'), kind: 'rest', duration: d, staff });
      }
      for (const v of voices) {
        for (const e of v.events) {
          if (e.kind !== 'chord') continue;
          if (i.code === 'DUP_PITCH') {
            const seen = new Set<string>();
            e.notes = e.notes.filter((n) => { const k = pitchKey(n.pitch); if (seen.has(k)) return false; seen.add(k); return true; });
          }
          for (const n of e.notes) {
            if (n.id !== i.elementId) continue;
            if (i.code === 'TIE_BROKEN') n.tieStart = undefined;
            if (i.code === 'TIE_ORPHAN') n.tieStop = undefined;
          }
        }
        if (i.code === 'EMPTY_CHORD') {
          v.events = v.events.map((e) => (e.id === i.elementId && e.kind === 'chord' && !e.notes.length ? { id: e.id, kind: 'rest', duration: e.duration, staff: e.staff } : e));
        }
      }
    }
    s.revision++;
  },
});

function restFill(ticks: number) {
  const types = [['whole', 1920], ['half', 960], ['quarter', 480], ['eighth', 240], ['16th', 120], ['32nd', 60]] as const;
  const out: { type: (typeof types)[number][0]; dots: number }[] = [];
  let t = ticks;
  for (const [type, v] of types) while (t >= v) { out.push({ type, dots: 0 }); t -= v; }
  return out;
}

/**
 * Nhận dạng lại theo vùng: `source` là bản nhạc Audiveris đọc từ ảnh cắt của MỘT hệ thống.
 * Ô nhịp được ghép theo thứ tự trong hệ thống; chỉ ô nằm trong `targets` bị thay. Trả về null nếu số ô/bè
 * không khớp (khi đó giữ nguyên kết quả cũ, không đoán).
 */
export function replaceMeasuresFrom(
  score: ScoreDocument, source: ScoreDocument, systemMeasures: number[], targets: number[], engine: string,
): Command | null {
  if (source.parts.length !== score.parts.length) return null;
  if (source.measures.length !== systemMeasures.length) return null;
  return {
    label: 'Nhận dạng lại vùng',
    scope: () => ALL,
    apply: (s) => {
      for (const mi of targets) {
        const k = systemMeasures.indexOf(mi);
        const sm = source.measures[k];
        const tm = s.measures[mi];
        if (k < 0 || !sm || !tm) continue;
        s.parts.forEach((p, pi) => {
          const vs: Voice[] = JSON.parse(JSON.stringify(source.parts[pi]!.content[sm.id] ?? []));
          for (const v of vs) {
            v.id = newId('v');
            for (const e of v.events) {
              e.id = newId('e');
              s.provenance.unverifiedEventIds.push(e.id);
              if (e.kind === 'chord') for (const n of e.notes) n.id = newId('n');
            }
          }
          p.content[tm.id] = vs;
        });
        if (s.sheet) {
          const prev = s.sheet.reviews[tm.id];
          const g = s.sheet.measures.find((x) => x.measureIndex === mi);
          s.sheet.reviews[tm.id] = {
            measureId: tm.id, status: 'rerecognized', engine, at: new Date().toISOString(), issues: prev?.issues ?? [],
            box: prev?.box ?? (g ? { page: g.page, x: g.x, y: g.y, w: g.w, h: g.h } : { page: 0, x: 0, y: 0, w: 0, h: 0 }),
          };
        }
      }
      s.revision++;
    },
  };
}

/** Lưu kết quả đối chiếu thủ công một ô nhịp (kèm tọa độ vùng ảnh gốc) và đánh dấu đã xác minh */
export const recordReview = (review: MeasureReview): Command => ({
  label: review.status === 'flagged' ? 'Đánh dấu ô cần xem lại' : 'Xác nhận ô nhịp',
  scope: () => ALL,
  apply: (s) => {
    if (!s.sheet) return;
    s.sheet.reviews[review.measureId] = review;
    if (review.status !== 'flagged') {
      const ids = new Set<string>();
      for (const p of s.parts) for (const v of p.content[review.measureId] ?? []) for (const e of v.events) ids.add(e.id);
      s.provenance.unverifiedEventIds = s.provenance.unverifiedEventIds.filter((id) => !ids.has(id));
    }
    s.revision++;
  },
});

/** Chuyển bản nhạc ảnh/PDF sang chế độ biên tập (sau khi đã trừ credit) */
export const enterEditMode = (conversion: NonNullable<SheetSource['conversion']>, issues: RuleIssue[]): Command => ({
  label: 'Chuyển sang Edit',
  scope: () => ALL,
  apply: (s) => {
    if (!s.sheet) return;
    s.sheet.mode = 'edit';
    s.sheet.conversion = conversion;
    for (const i of issues) {
      if (s.sheet.reviews[i.measureId]) continue;
      const g = s.sheet.measures.find((x) => x.measureIndex === i.measureIndex);
      s.sheet.reviews[i.measureId] = {
        measureId: i.measureId, status: 'flagged', engine: 'audiveris', at: new Date().toISOString(),
        issues: [...new Set(issues.filter((x) => x.measureIndex === i.measureIndex).map((x) => x.code))],
        box: g ? { page: g.page, x: g.x, y: g.y, w: g.w, h: g.h } : { page: 0, x: 0, y: 0, w: 0, h: 0 },
      };
    }
    s.revision++;
  },
});

/**
 * Áp dụng hoá biểu mà OMR bỏ sót: đặt hoá biểu từ ô `from` và sửa cao độ các nốt KHÔNG có dấu hoá viết riêng
 * (dấu hoá tạm thời trong cùng ô nhịp vẫn được tôn trọng). Người dùng chọn hoá biểu; không tự đoán.
 */
export const applyMissedKey = (from: number, fifths: number, mode: 'major' | 'minor' = 'major'): Command => ({
  label: 'Áp dụng hoá biểu bị sót',
  scope: () => ALL,
  apply: (s) => {
    s.keyMap = s.keyMap.filter((k) => k.measureIndex < from || k.measureIndex > from);
    s.keyMap.push({ measureIndex: from, fifths, mode });
    s.keyMap.sort((a, b) => a.measureIndex - b.measureIndex);
    const nextKey = s.keyMap.find((k) => k.measureIndex > from)?.measureIndex ?? s.measures.length;
    for (let mi = from; mi < nextKey; mi++) {
      const m = s.measures[mi]!;
      for (const p of s.parts) {
        for (const v of p.content[m.id] ?? []) {
          const carried = new Set<string>(); // bậc+quãng tám đã có dấu hoá viết riêng trong ô
          for (const e of v.events) {
            if (e.kind !== 'chord') continue;
            for (const n of e.notes) {
              const k = `${n.pitch.step}${n.pitch.octave}`;
              if (n.writtenAccidental) { carried.add(k); continue; }
              if (carried.has(k) || n.tieStop) continue;
              n.pitch.alter = keyAlter(fifths, n.pitch.step);
            }
          }
        }
      }
    }
    s.revision++;
  },
});
