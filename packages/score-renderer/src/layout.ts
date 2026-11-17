/**
 * Basic layout engine — renderer dự phòng của Phase 1 (Verovio WASM sẽ là renderer chính ở Phase 2).
 * Tính vị trí của mọi phần tử theo ID ổn định để highlight, click-to-select, auto-scroll.
 * Thuần TypeScript, không phụ thuộc DOM → test được.
 */
import {
  diatonicNumber, eventTicksIn, keyAt, measureTicks, timeSigAt,
  type ChordEvent, type Clef, type MusicEvent, type Pitch, type ScoreDocument,
} from '@holy-melody/music-core';

export interface LayoutOptions {
  width: number;
  /** khoảng cách dòng kẻ khuông (px) */
  sp?: number;
  marginX?: number;
  marginTop?: number;
  /** ô nhịp tối đa mỗi hệ thống (tự động nếu bỏ trống) */
  measuresPerSystem?: number;
}

export interface NoteHeadBox {
  noteId: string;
  eventId: string;
  partId: string;
  measureId: string;
  x: number;
  y: number;
  /** vị trí trên khuông: 0 = dòng dưới cùng, mỗi bậc = nửa khoảng */
  staffPos: number;
  filled: boolean;
  accidental?: string;
  ledger: number[];
}

export interface EventBox {
  event: MusicEvent;
  partId: string;
  measureId: string;
  staffY: number;
  x: number;
  heads: NoteHeadBox[];
  stemUp: boolean;
  lyrics: { verse: number; text: string; hyphen: boolean; extend: boolean; dx: number; y: number; verseLabel?: string; hyphenX?: number; extendTo?: number }[];
  voice: number;
  measureIndex: number;
  /** tick bắt đầu trong ô nhịp */
  start: number;
  systemIndex: number;
  /** đầu tự do của thân nốt (y), tính lại khi nằm trong chùm */
  stemX: number;
  stemEnd: number;
  /** số vạch chùm (0 = không chùm → vẽ cờ) */
  beams: number;
  beamed: boolean;
}

export interface Curve {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** cong lên (true) hay xuống */
  up: boolean;
}

export interface BeamGroup {
  eventIds: string[];
  stemUp: boolean;
  /** đường chùm chính */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** vạch phụ: [xStart, xEnd, level] */
  secondary: [number, number, number][];
}

export interface TupletMark {
  x1: number;
  x2: number;
  y: number;
  number: number;
  bracket: boolean;
  up: boolean;
}

export interface StaffBox {
  partId: string;
  staffIndex: number;
  y: number;
  clef: Clef;
}

export interface MeasureBox {
  measureId: string;
  index: number;
  number: string;
  x: number;
  width: number;
  systemIndex: number;
}

export interface SystemBox {
  index: number;
  y: number;
  height: number;
  staves: StaffBox[];
  measures: MeasureBox[];
  showKey: boolean;
  keyFifths: number;
  timeSig?: { beats: number; beatType: number };
}

export interface ScoreLayout {
  sp: number;
  width: number;
  height: number;
  /** lề trái/phải thực tế (px) */
  marginX: number;
  systems: SystemBox[];
  events: EventBox[];
  heads: Map<string, NoteHeadBox>;
  measures: Map<string, MeasureBox>;
  chordSymbols: { id: string; x: number; y: number; text: string }[];
  lyricStyle: { fontPx: number; family: string; italicVerses: number[] };
  beams: BeamGroup[];
  ties: Curve[];
  slurs: Curve[];
  tuplets: TupletMark[];
  dynamics: { id: string; x: number; y: number; mark: string }[];
}

const CLEF_REF: Record<string, Pitch> = {
  G: { step: 'G', alter: 0, octave: 4 },
  F: { step: 'F', alter: 0, octave: 3 },
  C: { step: 'C', alter: 0, octave: 4 },
  percussion: { step: 'B', alter: 0, octave: 4 },
};

/** Số nửa-khoảng từ dòng dưới cùng của khuông */
export function staffPosition(p: Pitch, clef: Clef): number {
  const ref = CLEF_REF[clef.sign] ?? CLEF_REF.G!;
  const refPos = (clef.line - 1) * 2;
  return diatonicNumber(p) - diatonicNumber(ref) - 7 * (clef.octaveChange ?? 0) + refPos;
}

const ACC: Record<number, string> = { [-2]: '𝄫', [-1]: '♭', 0: '♮', 1: '♯', 2: '𝄪' };
const CHORD_SUFFIX: Record<string, string> = {
  major: '', minor: 'm', diminished: 'dim', augmented: 'aug', dominant: '7', 'major-seventh': 'maj7',
  'minor-seventh': 'm7', 'half-diminished': 'm7♭5', 'diminished-seventh': 'dim7', 'suspended-fourth': 'sus4',
  'suspended-second': 'sus2', 'major-sixth': '6', 'minor-sixth': 'm6', power: '5',
};
const pcName = (pc: { step: string; alter: number }) => pc.step + (pc.alter > 0 ? '♯'.repeat(pc.alter) : '♭'.repeat(-pc.alter));

export function layoutScore(score: ScoreDocument, opts: LayoutOptions): ScoreLayout {
  const first = layoutOnce(score, opts);
  // Tránh hệ thống cuối chỉ có một ô nhịp: chia đều số ô cho các hệ thống
  const n = first.systems.length;
  if (!opts.measuresPerSystem && n > 1 && first.systems[n - 1]!.measures.length === 1 && score.measures.length > 2) {
    const balanced = layoutOnce(score, { ...opts, measuresPerSystem: Math.ceil(score.measures.length / n) });
    if (balanced.systems.length === n) return balanced;
  }
  return first;
}

function layoutOnce(score: ScoreDocument, opts: LayoutOptions): ScoreLayout {
  const sp = opts.sp ?? 8;
  // Lề lấy theo thiết lập trang của bản nhạc (mm), quy đổi theo tỉ lệ khổ giấy → khuông không sát mép giấy
  const L = score.layout;
  const pageWmm = L.orientation === 'landscape' ? (L.pageSize === 'A5' ? 210 : L.pageSize === 'Letter' ? 279 : L.pageSize === 'Custom' ? L.pageHeightMm : 297)
    : (L.pageSize === 'A5' ? 148 : L.pageSize === 'Letter' ? 216 : L.pageSize === 'Custom' ? L.pageWidthMm : 210);
  const pxPerMm = opts.width / pageWmm;
  const marginX = opts.marginX ?? Math.max(sp * 5, Math.round(Math.max(L.marginsMm.left, L.marginsMm.right) * pxPerMm));
  const marginTop = opts.marginTop ?? Math.max(sp * 5, Math.round(L.marginsMm.top * pxPerMm));
  const staffH = sp * 4;
  const usable = opts.width - marginX * 2;

  const verses = Math.max(0, ...score.parts.flatMap((p) => Object.values(p.content).flatMap((vs) => vs.flatMap((v) => v.events.flatMap((e) => (e.kind === 'chord' ? e.lyrics.map((l) => l.verse) : []))))));
  const hasChords = score.chordSymbols.length > 0;
  // ---- kiểu lời ca theo thiết lập (pt → px theo tỉ lệ khoảng dòng kẻ thật)
  const LS = score.layout;
  const lyricPx = Math.round((LS.lyricFontSizePt ?? 10) * 0.3528 * (sp / (LS.staffSpaceMm || 1.75)) * 10) / 10;
  const lyricOffset = (LS.lyricOffsetSp ?? 3) * sp;
  const verseSpacing = Math.max(lyricPx * 1.15, (LS.lyricVerseSpacingSp ?? 2.2) * sp);
  /** bề rộng trung bình một ký tự lời ca */
  const charW = lyricPx * 0.56;
  const staffGap = sp * 6 + (verses ? lyricOffset - sp * 1.5 + (verses - 1) * verseSpacing + lyricPx * 0.4 : 0);
  const staves: { partId: string; staffIndex: number; clef: Clef }[] = score.parts.flatMap((p) =>
    p.staves.map((s, i) => ({ partId: p.id, staffIndex: i, clef: s.clef })),
  );

  // ---- độ rộng tự nhiên của từng ô nhịp (theo các thời điểm bắt đầu nốt)
  const onsetsByMeasure = score.measures.map((m, mi) => {
    const set = new Map<number, number>(); // tick → độ dài ngắn nhất bắt đầu tại đó
    const lyr = new Map<number, number>(); // tick → số ký tự lời dài nhất
    const acc = new Set<number>(); // tick có nốt mang dấu hóa (cần chừa chỗ phía trước)
    for (const p of score.parts) {
      for (const v of p.content[m.id] ?? []) {
        const t = eventTicksIn(score, mi, v.events);
        v.events.forEach((e, i) => {
          if (e.kind === 'chord' && e.grace) {
            acc.add(t[i]!.start); // chừa chỗ cho nốt hoa mỹ như dấu hóa
            return;
          }
          const cur = set.get(t[i]!.start);
          set.set(t[i]!.start, Math.min(cur ?? Infinity, t[i]!.ticks));
          if (e.kind === 'chord' && e.notes.some((n) => n.pitch.alter !== 0 || n.accidentalDisplay === 'show')) acc.add(t[i]!.start);
          if (e.kind === 'chord') for (const l of e.lyrics) lyr.set(t[i]!.start, Math.max(lyr.get(t[i]!.start) ?? 0, l.text.length + (l.syllabic === 'begin' || l.syllabic === 'middle' ? 2 : 0)));
        });
      }
    }
    return [...set.entries()].sort((a, b) => a[0] - b[0]).map(([t, d]) => [t, d, lyr.get(t) ?? 0, acc.has(t) ? 1 : 0] as [number, number, number, number]);
  });
  /**
   * Khoảng cách theo trường độ trên thang log (như các phần mềm ký âm chuyên nghiệp):
   * nốt dài hơn chiếm chỗ nhiều hơn nhưng không tuyến tính → dòng nhạc đều mắt.
   * Đồng thời không nhỏ hơn bề rộng chữ lời ca (~0.82sp/ký tự ở cỡ 11.5px).
   */
  const onsetWidth = (d: number, chars: number) =>
    Math.max(sp * (1.5 + 1.3 * Math.log2(1 + d / 120)), chars ? chars * charW + sp * 1.1 : 0);
  /** Đệm sau vạch nhịp (thêm chỗ nếu nốt đầu có dấu hóa) và trước vạch nhịp kế tiếp */
  const padLeft = (ons: [number, number, number, number][]) => sp * 1.9 + (ons[0]?.[3] ? sp * 2 : 0);
  const PAD_RIGHT = sp * 0.6;
  /** Chỗ cho dấu hóa của nốt kế tiếp được cộng vào ô trước nó */
  const slotWidths = (ons: [number, number, number, number][]) =>
    ons.map(([, d, c], i) => onsetWidth(d, c) + (ons[i + 1]?.[3] ? sp * 1.9 : 0));
  const natural = onsetsByMeasure.map((ons) =>
    ons.length === 0 ? sp * 8 : padLeft(ons) + PAD_RIGHT + slotWidths(ons).reduce((a, b) => a + b, 0));

  // ---- chia hệ thống
  const systems: SystemBox[] = [];
  const headerW = (mi: number, first: boolean) => {
    const k = Math.abs(keyAt(score, mi).fifths);
    return sp * 5 + k * sp * 1.1 + (first ? sp * 3.5 : 0);
  };
  let mi = 0;
  let y = marginTop + (score.meta.title ? 70 : 0);
  while (mi < score.measures.length) {
    const first = mi === 0;
    const start = mi;
    let w = headerW(mi, first);
    const maxN = opts.measuresPerSystem ?? Infinity;
    while (mi < score.measures.length && (mi === start || (w + natural[mi]! <= usable && mi - start < maxN && !score.measures[mi]!.systemBreak))) {
      w += natural[mi]!;
      mi++;
    }
    const idxs = Array.from({ length: mi - start }, (_, k) => start + k);
    const head = headerW(start, first);
    const last = mi >= score.measures.length;
    const totalNat = idxs.reduce((s, k) => s + natural[k]!, 0);
    const scale = last && !opts.measuresPerSystem && (idxs.length < 2 || totalNat + head < usable * 0.4) ? 1.15 : (usable - head) / totalNat;
    let x = marginX + head;
    const measures: MeasureBox[] = idxs.map((k) => {
      const mw = natural[k]! * scale;
      const box = { measureId: score.measures[k]!.id, index: k, number: score.measures[k]!.number, x, width: mw, systemIndex: systems.length };
      x += mw;
      return box;
    });
    const top = y + (hasChords ? sp * 4.8 : sp * 1.5);
    const sys: SystemBox = {
      index: systems.length,
      y: top,
      height: 0,
      staves: staves.map((s, i) => ({ ...s, y: top + i * (staffH + staffGap) })),
      measures,
      showKey: true,
      keyFifths: keyAt(score, start).fifths,
      timeSig: first || score.timeSigMap.some((t) => t.measureIndex === start) ? timeSigAt(score, start) : undefined,
    };
    sys.height = staves.length * staffH + (staves.length - 1) * staffGap;
    systems.push(sys);
    y = top + sys.height + staffGap + sp * 2;
  }

  // ---- đặt nốt
  const events: EventBox[] = [];
  const heads = new Map<string, NoteHeadBox>();
  const measureBoxes = new Map<string, MeasureBox>();
  const chordSymbols: ScoreLayout['chordSymbols'] = [];
  const seenVerse = new Set<string>();

  for (const sys of systems) {
    for (const mb of sys.measures) {
      measureBoxes.set(mb.measureId, mb);
      const m = score.measures[mb.index]!;
      const ons = onsetsByMeasure[mb.index]!;
      const left = padLeft(ons);
      const inner = mb.width - left - PAD_RIGHT;
      const weights = slotWidths(ons);
      const totalW = weights.reduce((a, b) => a + b, 0) || 1;
      const xAt = new Map<number, number>();
      let acc = mb.x + left;
      ons.forEach(([t], i) => {
        xAt.set(t, acc);
        acc += (weights[i]! / totalW) * inner;
      });
      const mLen = measureTicks(score, mb.index);
      const xForTick = (t: number) => xAt.get(t) ?? mb.x + left + (t / mLen) * inner;

      for (const part of score.parts) {
        const voices = part.content[m.id] ?? [];
        for (const v of voices) {
          const timings = eventTicksIn(score, mb.index, v.events);
          const multiVoice = voices.filter((o) => (o.events[0]?.staff ?? 0) === (v.events[0]?.staff ?? 0)).length > 1;
          v.events.forEach((ev, i) => {
            const staff = sys.staves.find((s) => s.partId === part.id && s.staffIndex === ev.staff) ?? sys.staves.find((s) => s.partId === part.id)!;
            const x = ev.kind === 'rest' && ev.measureRest ? mb.x + mb.width / 2 - sp : xForTick(timings[i]!.start) - (ev.kind === 'chord' && ev.grace ? sp * 1.9 : 0);
            const box: EventBox = {
              event: ev, partId: part.id, measureId: m.id, staffY: staff.y, x, heads: [], stemUp: true, lyrics: [],
              voice: v.number, measureIndex: mb.index, start: timings[i]!.start, systemIndex: sys.index,
              stemX: x, stemEnd: 0, beams: 0, beamed: false,
            };
            if (ev.kind === 'chord') {
              const positions = ev.notes.map((n) => staffPosition(n.pitch, staff.clef));
              const avg = positions.reduce((a, b) => a + b, 0) / Math.max(1, positions.length);
              box.stemUp = multiVoice ? v.number % 2 === 1 : avg < 4;
              ev.notes.forEach((n, k) => {
                const pos = positions[k]!;
                const ledger: number[] = [];
                for (let l = -2; l >= pos; l -= 2) ledger.push(l);
                for (let l = 10; l <= pos; l += 2) ledger.push(l);
                const head: NoteHeadBox = {
                  noteId: n.id, eventId: ev.id, partId: part.id, measureId: m.id, x, y: staff.y + staffH - (pos * sp) / 2,
                  staffPos: pos, filled: !['whole', 'half'].includes(ev.duration.type), ledger,
                  accidental: needsAccidental(score, mb.index, ev, k) ? ACC[n.pitch.alter] : undefined,
                };
                box.heads.push(head);
                heads.set(n.id, head);
              });
              box.lyrics = (ev as ChordEvent).lyrics.map((l) => {
                const first = !seenVerse.has(`${part.id}:${l.verse}`);
                seenVerse.add(`${part.id}:${l.verse}`);
                return {
                  verse: l.verse, text: l.text, hyphen: l.syllabic === 'begin' || l.syllabic === 'middle', extend: !!l.extend,
                  dx: (l.offsetX ?? 0) * sp, y: staff.y + sp * 4 + lyricOffset + (l.verse - 1) * verseSpacing,
                  verseLabel: first && verses > 1 && LS.showVerseNumbers !== false ? `${l.verse}.` : undefined,
                };
              });
            }
            events.push(box);
          });
        }
      }
      for (const c of score.chordSymbols.filter((c) => c.measureId === m.id)) {
        const st = sys.staves.find((s) => s.partId === c.partId) ?? sys.staves[0]!;
        chordSymbols.push({ id: c.id, x: xForTick(c.offset) - sp * 0.5, y: st.y - sp * 3.9, text: pcName(c.root) + (CHORD_SUFFIX[c.kind] ?? '') + (c.bass ? `/${pcName(c.bass)}` : '') });
      }
    }
  }
  const lastSys = systems[systems.length - 1];
  const deco = decorate(score, events, systems, measureBoxes, sp);
  // cường độ: trên khuông nếu bè có lời ca (tránh chồng lời), ngược lại dưới khuông
  const dynamics: ScoreLayout['dynamics'] = [];
  for (const d of score.dynamics) {
    const mb = measureBoxes.get(d.measureId);
    if (!mb) continue;
    const sys = systems[mb.systemIndex]!;
    const st = sys.staves.find((x) => x.partId === d.partId) ?? sys.staves[0]!;
    const ev = events.find((e) => e.measureId === d.measureId && e.partId === d.partId && e.start === d.offset);
    const hasLyrics = events.some((e) => e.partId === d.partId && e.lyrics.length);
    dynamics.push({ id: d.id, x: ev?.x ?? mb.x + sp * 2, y: hasLyrics ? st.y - sp * 0.9 : st.y + sp * 6.5, mark: d.mark });
  }
  return {
    ...deco, dynamics,
    lyricStyle: { fontPx: lyricPx, family: LS.lyricFont || 'Noto Serif', italicVerses: LS.lyricItalicVerses ?? [] },
    sp, width: opts.width, marginX,
    height: lastSys ? lastSys.y + lastSys.height + staffGap + marginTop : 200,
    systems, events, heads, measures: measureBoxes, chordSymbols,
  };
}

/** Hiển thị dấu hóa khi khác hóa biểu hoặc khác dấu hóa trước đó trong ô (cùng khuông, cùng cao độ viết) */
function needsAccidental(score: ScoreDocument, mi: number, ev: ChordEvent, k: number): boolean {
  const n = ev.notes[k]!;
  if (n.accidentalDisplay === 'hide') return false;
  if (n.accidentalDisplay === 'show' || n.accidentalDisplay === 'cautionary') return true;
  if (n.tieStop) return false;
  const fifths = keyAt(score, mi).fifths;
  const order = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const idx = order.indexOf(n.pitch.step);
  const keyAlter = fifths > 0 ? (idx < fifths ? 1 : 0) : fifths < 0 ? (6 - idx < -fifths ? -1 : 0) : 0;
  // dấu hóa trước đó trong cùng ô
  const m = score.measures[mi]!;
  for (const part of score.parts) {
    for (const v of part.content[m.id] ?? []) {
      let prior: number | undefined;
      for (const e of v.events) {
        if (e === ev) {
          const cur = prior ?? keyAlter;
          return cur !== n.pitch.alter;
        }
        if (e.kind === 'chord' && e.staff === ev.staff) {
          for (const o of e.notes) if (o.pitch.step === n.pitch.step && o.pitch.octave === n.pitch.octave) prior = o.pitch.alter;
        }
      }
    }
  }
  return keyAlter !== n.pitch.alter;
}


// ====================================================================== thân nốt, chùm, nối, luyến, liên

const FLAGS: Record<string, number> = { eighth: 1, '16th': 2, '32nd': 3, '64th': 4 };

function decorate(score: ScoreDocument, events: EventBox[], systems: SystemBox[], measures: Map<string, MeasureBox>, sp: number) {
  const beams: BeamGroup[] = [];
  const ties: Curve[] = [];
  const slurs: Curve[] = [];
  const tuplets: TupletMark[] = [];

  // thân nốt mặc định
  for (const e of events) {
    if (e.event.kind !== 'chord' || !e.heads.length) continue;
    const ys = e.heads.map((h) => h.y);
    const scale = e.event.grace ? 0.7 : 1;
    e.stemX = e.stemUp ? e.x + sp * 0.62 * scale : e.x - sp * 0.62 * scale;
    e.stemEnd = e.stemUp ? Math.min(...ys) - sp * 3.4 * scale : Math.max(...ys) + sp * 3.4 * scale;
    e.beams = e.event.grace ? 1 : FLAGS[e.event.duration.type] ?? 0;
  }

  // nhóm theo (part, voice) theo thứ tự thời gian
  const byVoice = new Map<string, EventBox[]>();
  for (const e of events) {
    const k = `${e.partId}:${e.voice}`;
    (byVoice.get(k) ?? byVoice.set(k, []).get(k)!).push(e);
  }
  for (const list of byVoice.values()) list.sort((a, b) => a.measureIndex - b.measureIndex || a.start - b.start || (a.event.kind === 'chord' && a.event.grace ? -1 : 1));

  for (const list of byVoice.values()) {
    // ---- chùm nốt: gom theo phách trong cùng ô nhịp
    let group: EventBox[] = [];
    const flush = () => {
      if (group.length >= 2) beams.push(makeBeam(group, sp));
      group = [];
    };
    for (const e of list) {
      const ev = e.event;
      const beamable = ev.kind === 'chord' && !ev.grace && (FLAGS[ev.duration.type] ?? 0) > 0;
      const ts = score.timeSigMap.reduce((a, t) => (t.measureIndex <= e.measureIndex ? t : a), score.timeSigMap[0]!);
      const groupTicks = ts.beatType === 8 && ts.beats % 3 === 0 ? 720 : ts.beatType === 8 ? 240 : 480 * (4 / ts.beatType);
      const prev = group[group.length - 1];
      if (!beamable || (prev && (prev.measureIndex !== e.measureIndex || Math.floor(prev.start / groupTicks) !== Math.floor(e.start / groupTicks)))) flush();
      if (beamable) group.push(e);
    }
    flush();

    // ---- dấu nối & dấu luyến
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.event.kind !== 'chord') continue;
      const next = list.slice(i + 1).find((x) => x.event.kind === 'chord' && !x.event.grace);
      for (const h of e.heads) {
        const note = e.event.notes.find((n) => n.id === h.noteId);
        if (!note?.tieStart || !next) continue;
        const target = next.heads.find((x) => x.staffPos === h.staffPos);
        if (!target) continue;
        const up = !e.stemUp;
        const dy = up ? -sp * 0.55 : sp * 0.55;
        pushCurve(ties, `tie-${h.noteId}`, e, next, h.x + sp * 0.7, h.y + dy, target.x - sp * 0.7, target.y + dy, up, systems, measures, sp);
      }
      if (e.event.slurStart) {
        const end = list.slice(i + 1).find((x) => x.event.kind === 'chord' && x.event.slurStop);
        if (end) {
          const up = !e.stemUp;
          const yOf = (b: EventBox) => (up ? Math.min(...b.heads.map((h) => h.y)) - sp * 1.1 : Math.max(...b.heads.map((h) => h.y)) + sp * 1.1);
          pushCurve(slurs, `slur-${e.event.id}`, e, end, e.x + sp * 0.3, yOf(e), end.x - sp * 0.3, yOf(end), up, systems, measures, sp);
        }
      }
    }

    // ---- gạch nối âm tiết ở giữa hai chữ; gạch ngân (melisma) tới nốt cuối trước chữ kế tiếp
    for (let i = 0; i < list.length; i++) {
      for (const l of list[i]!.lyrics) {
        if (!l.hyphen && !l.extend) continue;
        let j = i + 1;
        while (j < list.length && !list[j]!.lyrics.some((x) => x.verse === l.verse)) j++;
        const next = list[j];
        if (l.hyphen && next && next.systemIndex === list[i]!.systemIndex) l.hyphenX = (list[i]!.x + l.dx + next.x + (next.lyrics.find((x) => x.verse === l.verse)?.dx ?? 0)) / 2;
        if (l.extend) {
          const lastHeld = list[Math.max(i, (next ? j : list.length) - 1)]!;
          if (lastHeld.systemIndex === list[i]!.systemIndex && lastHeld !== list[i]) l.extendTo = lastHeld.x + sp * 0.6;
        }
      }
    }

    // ---- nhóm liên
    let k = 0;
    while (k < list.length) {
      const t = list[k]!.event.duration.tuplet;
      if (!t || (list[k]!.event.kind === 'chord' && (list[k]!.event as { grace?: boolean }).grace)) {
        k++;
        continue;
      }
      const grp = list.slice(k, k + t.actual).filter((x) => x.event.duration.tuplet?.actual === t.actual && x.measureIndex === list[k]!.measureIndex);
      const chords = grp.filter((x) => x.event.kind === 'chord');
      const up = chords.length ? chords.filter((x) => x.stemUp).length >= chords.length / 2 : true;
      const fullyBeamed = grp.length > 1 && grp.every((x) => x.beamed) && beams.some((b) => grp.every((x) => b.eventIds.includes(x.event.id)));
      const ext = grp.map((x) => (x.event.kind === 'chord' ? x.stemEnd : x.staffY + sp * 2));
      const y = up ? Math.min(...ext, grp[0]!.staffY) - sp * 1.2 : Math.max(...ext, grp[0]!.staffY + sp * 4) + sp * 1.2;
      tuplets.push({ x1: grp[0]!.x - sp * 0.6, x2: grp[grp.length - 1]!.x + sp * 0.9, y, number: t.actual, bracket: !fullyBeamed, up });
      k += Math.max(1, grp.length);
    }
  }
  return { beams, ties, slurs, tuplets };
}

function makeBeam(group: EventBox[], sp: number): BeamGroup {
  const allPos = group.flatMap((e) => e.heads.map((h) => h.staffPos));
  const up = allPos.reduce((a, b) => a + b, 0) / allPos.length < 4;
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const ext = (e: EventBox) => (up ? Math.min(...e.heads.map((h) => h.y)) : Math.max(...e.heads.map((h) => h.y)));
  for (const e of group) {
    e.stemUp = up;
    e.stemX = up ? e.x + sp * 0.62 : e.x - sp * 0.62;
    e.beamed = true;
  }
  const x1 = first.stemX;
  const x2 = last.stemX;
  let slope = x2 === x1 ? 0 : (ext(last) - ext(first)) / (x2 - x1);
  slope = Math.max(-0.12, Math.min(0.12, slope));
  // dịch đường chùm để mọi thân nốt dài tối thiểu 3 khoảng
  let y1 = up ? Infinity : -Infinity;
  for (const e of group) {
    const need = up ? ext(e) - sp * 3.2 : ext(e) + sp * 3.2;
    const cand = need - slope * (e.stemX - x1);
    y1 = up ? Math.min(y1, cand) : Math.max(y1, cand);
  }
  const yAt = (x: number) => y1 + slope * (x - x1);
  for (const e of group) e.stemEnd = yAt(e.stemX);
  const secondary: [number, number, number][] = [];
  const maxLevel = Math.max(...group.map((e) => e.beams));
  for (let level = 2; level <= maxLevel; level++) {
    let runStart = -1;
    group.forEach((e, i) => {
      const has = e.beams >= level;
      if (has && runStart < 0) runStart = i;
      if ((!has || i === group.length - 1) && runStart >= 0) {
        const endI = has ? i : i - 1;
        const a = group[runStart]!.stemX;
        const b = group[endI]!.stemX;
        // nốt lẻ: vạch cụt hướng về phía nốt kề
        if (runStart === endI) secondary.push(runStart === 0 ? [a, a + sp * 1.2, level] : [a - sp * 1.2, a, level]);
        else secondary.push([a, b, level]);
        runStart = -1;
      }
    });
  }
  return { eventIds: group.map((e) => e.event.id), stemUp: up, x1, y1: yAt(x1), x2, y2: yAt(x2), secondary };
}

/** Đường cong; nếu hai đầu khác hệ thống thì tách thành hai nửa ở cuối/đầu dòng */
function pushCurve(out: Curve[], id: string, a: EventBox, b: EventBox, x1: number, y1: number, x2: number, y2: number, up: boolean,
  systems: SystemBox[], measures: Map<string, MeasureBox>, sp: number) {
  if (a.systemIndex === b.systemIndex) {
    out.push({ id, x1, y1, x2, y2, up });
    return;
  }
  const sa = systems[a.systemIndex]!;
  const lastM = sa.measures[sa.measures.length - 1]!;
  out.push({ id: `${id}-a`, x1, y1, x2: lastM.x + lastM.width - sp * 0.4, y2: y1, up });
  const sb = systems[b.systemIndex]!;
  const firstM = measures.get(sb.measures[0]!.measureId)!;
  out.push({ id: `${id}-b`, x1: firstM.x - sp * 0.4, y1: y2, x2, y2, up });
}
