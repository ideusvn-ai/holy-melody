/**
 * Composition Advisor — Trợ lý soạn nhạc.
 *
 * Phân tích bản nhạc và đưa ra GỢI Ý (không bao giờ tự sửa):
 *   - Quy tắc soạn giai điệu và phối bè
 *   - Cấu trúc bài thánh ca
 *   - Sự phù hợp giữa dấu thanh tiếng Việt và hướng đi giai điệu
 * Người dùng có thể bỏ qua từng gợi ý (lưu ở score.advisor.dismissed) hoặc tắt cả quy tắc.
 * Mỗi gợi ý có id ổn định (rule + id phần tử), nên gợi ý đã bỏ qua không xuất hiện lại.
 */
import type { MusicEvent, Part, Pitch, ScoreDocument } from './model.js';
import { diatonicNumber, fifthsToPitchClass, mod, pitchName, pitchToMidi } from './pitch.js';
import { eventTicksIn, keyAt, measureStartTicks, measureTicks, nominalMeasureTicks, validateScore } from './score.js';
import { detectTone, endsPhrase, isSyllable, stripPunctuation, TONE_LABEL, type VietTone } from './vietnamese.js';

export type AdvisorCategory = 'melody' | 'harmony' | 'range' | 'structure' | 'lyrics' | 'notation';
export type AdvisorSeverity = 'info' | 'suggestion' | 'warning';

export type AdvisorRule =
  | 'melody.leap-large' | 'melody.augmented' | 'melody.leap-recovery' | 'melody.consecutive-leaps' | 'melody.leading-tone'
  | 'range.voice' | 'range.congregation'
  | 'harmony.parallel' | 'harmony.crossing' | 'harmony.spacing'
  | 'structure.final-tonic' | 'structure.final-bass' | 'structure.final-barline' | 'structure.pickup-balance'
  | 'structure.phrase-length' | 'structure.climax' | 'structure.cadence-variety'
  | 'lyrics.tone-contour' | 'lyrics.missing'
  | 'notation.measure-fill';

export interface AdvisorSuggestion {
  /** Ổn định qua các lần phân tích: dùng làm khóa bỏ qua */
  id: string;
  rule: AdvisorRule;
  category: AdvisorCategory;
  severity: AdvisorSeverity;
  message: string;
  /** Giải thích ngắn tại sao, để người học hiểu */
  rationale: string;
  partId?: string;
  measureId?: string;
  measureIndex?: number;
  noteIds: string[];
}

export const RULE_INFO: Record<AdvisorRule, { category: AdvisorCategory; title: string }> = {
  'melody.leap-large': { category: 'melody', title: 'Quãng nhảy lớn hơn quãng 8' },
  'melody.augmented': { category: 'melody', title: 'Quãng tăng/giảm khó hát' },
  'melody.leap-recovery': { category: 'melody', title: 'Bước nhảy chưa được bù' },
  'melody.consecutive-leaps': { category: 'melody', title: 'Nhiều bước nhảy cùng chiều' },
  'melody.leading-tone': { category: 'melody', title: 'Cảm âm chưa giải quyết' },
  'range.voice': { category: 'range', title: 'Ngoài âm vực của bè' },
  'range.congregation': { category: 'range', title: 'Âm vực khó cho cộng đoàn' },
  'harmony.parallel': { category: 'harmony', title: 'Song song quãng 5 / quãng 8' },
  'harmony.crossing': { category: 'harmony', title: 'Bè bắt chéo' },
  'harmony.spacing': { category: 'harmony', title: 'Khoảng cách bè quá xa' },
  'structure.final-tonic': { category: 'structure', title: 'Giai điệu kết chưa về chủ âm' },
  'structure.final-bass': { category: 'structure', title: 'Bè trầm kết chưa về chủ âm' },
  'structure.final-barline': { category: 'structure', title: 'Thiếu vạch kết bài' },
  'structure.pickup-balance': { category: 'structure', title: 'Ô lấy đà và ô cuối chưa bù nhau' },
  'structure.phrase-length': { category: 'structure', title: 'Độ dài câu nhạc' },
  'structure.climax': { category: 'structure', title: 'Điểm cao trào' },
  'structure.cadence-variety': { category: 'structure', title: 'Các câu đều kết về chủ âm' },
  'lyrics.tone-contour': { category: 'lyrics', title: 'Dấu thanh ngược hướng giai điệu' },
  'lyrics.missing': { category: 'lyrics', title: 'Nốt chưa có lời' },
  'notation.measure-fill': { category: 'notation', title: 'Ô nhịp thiếu/thừa phách' },
};

export interface AdvisorOptions {
  /** Bỏ qua gợi ý có id trong danh sách (mặc định lấy từ score.advisor.dismissed) */
  dismissed?: Iterable<string>;
  disabledRules?: Iterable<AdvisorRule>;
  categories?: AdvisorCategory[];
  /** Coi bài là thánh ca cộng đoàn (bật gợi ý cấu trúc và âm vực cộng đoàn). Mặc định true */
  hymnMode?: boolean;
  /** Ngưỡng bán cung để coi là chuyển động ngược dấu thanh (mặc định 2) */
  toneContourThreshold?: number;
}

// ---------------------------------------------------------------- dữ liệu nội bộ

type Role = 'S' | 'A' | 'T' | 'B' | 'melody' | 'other';

interface LineNote {
  noteId: string;
  event: MusicEvent & { kind: 'chord' };
  pitch: Pitch;
  /** cao độ thực */
  midi: number;
  start: number; // tick tuyệt đối (thứ tự viết, không unroll)
  end: number;
  measureIndex: number;
  measureId: string;
  /** có dấu lặng ngay trước nốt này */
  afterRest: boolean;
  phraseEnd: boolean;
}

interface Line {
  part: Part;
  voiceNumber: number;
  role: Role;
  label: string;
  notes: LineNote[];
}

const ROLE_RANGE: Record<'S' | 'A' | 'T' | 'B', [number, number, string]> = {
  S: [60, 79, 'Soprano (C4–G5)'],
  A: [55, 74, 'Alto (G3–D5)'],
  T: [48, 67, 'Tenor (C3–G4)'],
  B: [41, 62, 'Bass (F2–D4)'],
};
/** Âm vực cộng đoàn dễ hát (C4–D5) */
const CONGREGATION: [number, number] = [60, 74];

function roleFromName(name: string): Role | undefined {
  const n = name.toLowerCase().normalize('NFC');
  if (/\bsoprano\b|\bsop\b|nữ cao/.test(n)) return 'S';
  if (/\balto\b|nữ trầm|nữ thấp/.test(n)) return 'A';
  if (/\btenor\b|\bten\b|nam cao/.test(n)) return 'T';
  if (/\bbass\b|\bbaritone\b|nam trầm/.test(n)) return 'B';
  if (/melody|giai điệu|voice|giọng|solo|ca đoàn|cộng đoàn/.test(n)) return 'melody';
  return undefined;
}

function buildLines(score: ScoreDocument): Line[] {
  const starts = measureStartTicks(score);
  const lines: Line[] = [];
  for (const part of score.parts) {
    const byVoice = new Map<string, LineNote[]>();
    const voiceMeta = new Map<string, { staff: number; number: number }>();
    score.measures.forEach((m, mi) => {
      for (const v of part.content[m.id] ?? []) {
        const timings = eventTicksIn(score, mi, v.events);
        const staff = v.events[0]?.staff ?? 0;
        const key = `${staff}:${v.number}`;
        voiceMeta.set(key, { staff, number: v.number });
        const list = byVoice.get(key) ?? [];
        let restPending = false;
        v.events.forEach((ev, ei) => {
          const t = timings[ei]!;
          if (ev.kind === 'rest') {
            if (!ev.hidden && list.length) {
              restPending = true;
              if (t.ticks >= 240) list[list.length - 1]!.phraseEnd = true;
            }
            return;
          }
          if (ev.grace || ev.notes.length === 0) return;
          const top = [...ev.notes].sort((a, b) => pitchToMidi(b.pitch) - pitchToMidi(a.pitch))[0]!;
          if (top.tieStop) {
            // nốt nối tiếp: kéo dài nốt trước, không tạo bước mới
            const prev = list[list.length - 1];
            if (prev) prev.end = starts[mi]! + t.start + t.ticks;
            return;
          }
          const lyric = ev.lyrics.find((l) => l.verse === 1)?.text ?? '';
          list.push({
            noteId: top.id,
            event: ev,
            pitch: top.pitch,
            midi: pitchToMidi(top.pitch) + part.instrument.transposeChromatic,
            start: starts[mi]! + t.start,
            end: starts[mi]! + t.start + t.ticks,
            measureIndex: mi,
            measureId: m.id,
            afterRest: restPending || (list.length > 0 && list[list.length - 1]!.end < starts[mi]! + t.start),
            phraseEnd: ev.articulations.includes('fermata') || endsPhrase(lyric),
          });
          restPending = false;
        });
        byVoice.set(key, list);
      }
    });
    const keys = [...byVoice.keys()].sort((a, b) => {
      const ma = voiceMeta.get(a)!;
      const mb = voiceMeta.get(b)!;
      return ma.staff - mb.staff || ma.number - mb.number;
    });
    const named = roleFromName(part.name);
    const isChoir = /choir|satb|hợp xướng|ca đoàn|chorus/i.test(part.name) && keys.length === 4;
    keys.forEach((k, i) => {
      const notes = byVoice.get(k)!;
      if (notes.length === 0) return;
      let role: Role = 'other';
      if (isChoir) role = (['S', 'A', 'T', 'B'] as const)[i]!;
      else if (named && keys.length === 1) role = named;
      else if (named && named !== 'melody' && i === 0) role = named;
      lines.push({ part, voiceNumber: voiceMeta.get(k)!.number, role, label: isChoir ? `${part.name} (${role})` : part.name, notes });
    });
  }
  // Nếu không có bè nào được đặt tên: line đầu tiên là giai điệu chính
  if (lines.length && !lines.some((l) => l.role === 'S' || l.role === 'melody')) lines[0]!.role = 'melody';
  return lines;
}

// ---------------------------------------------------------------- helpers

const semis = (a: LineNote, b: LineNote) => b.midi - a.midi;
const degreeSteps = (a: LineNote, b: LineNote) => diatonicNumber(b.pitch) - diatonicNumber(a.pitch);

function tonicPc(score: ScoreDocument, measureIndex: number): number {
  const k = keyAt(score, measureIndex);
  const pc = fifthsToPitchClass(k.mode === 'minor' ? k.fifths + 3 : k.fifths);
  return mod(pitchToMidi({ ...pc, octave: 4 }), 12);
}

const INTERVAL_NAMES: Record<number, string> = {
  0: 'đồng âm', 1: 'quãng 2', 2: 'quãng 3', 3: 'quãng 4', 4: 'quãng 5', 5: 'quãng 6', 6: 'quãng 7', 7: 'quãng 8',
};

function syllableOf(n: LineNote): { text: string; tone: VietTone } | undefined {
  const raw = n.event.lyrics.find((l) => l.verse === 1)?.text;
  if (!raw) return undefined;
  const text = stripPunctuation(raw);
  if (!isSyllable(text)) return undefined;
  return { text, tone: detectTone(text) };
}

// ---------------------------------------------------------------- phân tích

export function analyzeComposition(score: ScoreDocument, opts: AdvisorOptions = {}): AdvisorSuggestion[] {
  const dismissed = new Set(opts.dismissed ?? score.advisor?.dismissed ?? []);
  const disabled = new Set<string>(opts.disabledRules ?? (score.advisor?.disabledRules as AdvisorRule[] | undefined) ?? []);
  const cats = opts.categories ? new Set(opts.categories) : undefined;
  const hymn = opts.hymnMode ?? true;
  const toneTh = opts.toneContourThreshold ?? 2;
  const out: AdvisorSuggestion[] = [];

  const add = (
    rule: AdvisorRule, severity: AdvisorSeverity, message: string, rationale: string,
    where: { part?: Part; measureIndex?: number; noteIds?: string[] },
  ) => {
    const info = RULE_INFO[rule];
    if (disabled.has(rule) || (cats && !cats.has(info.category))) return;
    const noteIds = where.noteIds ?? [];
    const m = where.measureIndex !== undefined ? score.measures[where.measureIndex] : undefined;
    const id = `${rule}:${noteIds.join(',') || `${where.part?.id ?? ''}:${m?.id ?? ''}`}`;
    if (dismissed.has(id) || out.some((s) => s.id === id)) return;
    out.push({
      id, rule, category: info.category, severity, message, rationale,
      partId: where.part?.id, measureId: m?.id, measureIndex: where.measureIndex, noteIds,
    });
  };

  const lines = buildLines(score);
  const melody = lines.find((l) => l.role === 'S') ?? lines.find((l) => l.role === 'melody');
  const bass = lines.find((l) => l.role === 'B');

  // ================= 1. Giai điệu từng bè
  for (const line of lines) {
    const ns = line.notes;
    for (let i = 1; i < ns.length; i++) {
      const a = ns[i - 1]!;
      const b = ns[i]!;
      if (b.afterRest || a.phraseEnd) continue;
      const s = semis(a, b);
      const abs = Math.abs(s);
      const steps = Math.abs(degreeSteps(a, b));
      const where = { part: line.part, measureIndex: b.measureIndex, noteIds: [a.noteId, b.noteId] };
      const label = `${pitchName(a.pitch)} → ${pitchName(b.pitch)}`;

      if (abs > 12) {
        add('melody.leap-large', 'suggestion', `${line.label}: nhảy ${abs} bán cung (${label}).`,
          'Quãng nhảy lớn hơn quãng 8 rất khó hát chính xác, nhất là với ca đoàn và cộng đoàn.', where);
      }
      const simpleSteps = steps % 7;
      const simpleSemis = abs % 12;
      const augmented2 = simpleSteps === 1 && simpleSemis === 3;
      const tritone = (simpleSteps === 3 || simpleSteps === 4) && simpleSemis === 6;
      if (augmented2 || tritone) {
        add('melody.augmented', 'suggestion',
          `${line.label}: ${augmented2 ? 'quãng 2 tăng' : 'quãng 4 tăng / 5 giảm (tritone)'} (${label}).`,
          'Quãng tăng/giảm khó lấy cao độ; trong thánh ca nên đi bậc liền hoặc đổi nốt để thành quãng đúng.', where);
      }
      // bù bước nhảy
      const c = ns[i + 1];
      // Bè trầm nhảy quãng 4/5/8 theo nền hòa âm là bình thường → không áp dụng
      if (abs > 5 && abs <= 12 && line.role !== 'B' && !(abs === 7 || abs === 12) && c && !c.afterRest && !b.phraseEnd) {
        const next = semis(b, c);
        const recovers = Math.sign(next) === -Math.sign(s) && Math.abs(next) <= 2;
        if (!recovers) {
          add('melody.leap-recovery', 'info',
            `${line.label}: sau bước nhảy ${INTERVAL_NAMES[simpleSteps] ?? abs + ' bán cung'} (${label}) nên đi bậc liền theo chiều ngược lại.`,
            'Nguyên tắc giai điệu cổ điển: nhảy xa tạo "khoảng trống" cần được lấp lại bằng chuyển động bậc ngược chiều, giúp giai điệu cân bằng và dễ hát.',
            { ...where, noteIds: [a.noteId, b.noteId, c.noteId] });
        }
      }
      if (c && !c.afterRest && !b.phraseEnd) {
        const next = semis(b, c);
        if (abs >= 3 && Math.abs(next) >= 3 && Math.sign(next) === Math.sign(s) && abs + Math.abs(next) > 12) {
          add('melody.consecutive-leaps', 'info',
            `${line.label}: hai bước nhảy liên tiếp cùng chiều vượt quá quãng 8.`,
            'Nhiều bước nhảy cùng chiều làm giai điệu mất điểm tựa; nên xen chuyển động bậc.',
            { ...where, noteIds: [a.noteId, b.noteId, c.noteId] });
        }
      }
      // cảm âm (chỉ giai điệu chính, giọng trưởng)
      if ((line.role === 'S' || line.role === 'melody') && keyAt(score, a.measureIndex).mode === 'major') {
        const t = tonicPc(score, a.measureIndex);
        if (mod(a.midi, 12) === mod(t + 11, 12) && s < -2) {
          add('melody.leading-tone', 'info',
            `${line.label}: nốt cảm âm ${pitchName(a.pitch)} đi xuống nhảy thay vì lên chủ âm.`,
            'Bậc VII (cảm âm) có xu hướng giải quyết lên bậc I; ở giai điệu chính, nhảy xuống làm câu nhạc lơ lửng.', where);
        }
      }
    }
    // âm vực
    if (line.role === 'S' || line.role === 'A' || line.role === 'T' || line.role === 'B') {
      const [lo, hi, label] = ROLE_RANGE[line.role];
      const bad = line.notes.filter((n) => n.midi < lo || n.midi > hi);
      for (const n of bad.slice(0, 8)) {
        add('range.voice', 'suggestion', `${line.label}: ${pitchName(n.pitch)} nằm ngoài âm vực thoải mái của ${label}.`,
          'Nốt quá cao/thấp so với bè dễ bị hát sai hoặc vỡ giọng; cân nhắc chuyển giọng hoặc đổi nốt.',
          { part: line.part, measureIndex: n.measureIndex, noteIds: [n.noteId] });
      }
    }
  }

  // ================= 2. Phối bè (các bè có vai trò)
  const voiced = (['S', 'A', 'T', 'B'] as const).map((r) => lines.find((l) => l.role === r)).filter((l): l is Line => !!l);
  const onsetMap = (l: Line) => new Map(l.notes.map((n) => [n.start, n]));
  for (let i = 0; i < voiced.length; i++) {
    for (let j = i + 1; j < voiced.length; j++) {
      const up = voiced[i]!;
      const lo = voiced[j]!;
      const mu = onsetMap(up);
      const ml = onsetMap(lo);
      const common = [...mu.keys()].filter((t) => ml.has(t)).sort((a, b) => a - b);
      for (let k = 0; k < common.length; k++) {
        const u2 = mu.get(common[k]!)!;
        const l2 = ml.get(common[k]!)!;
        if (j === i + 1 && u2.midi < l2.midi) {
          add('harmony.crossing', 'info', `${up.role} thấp hơn ${lo.role} (${pitchName(u2.pitch)} < ${pitchName(l2.pitch)}).`,
            'Bè bắt chéo làm người nghe khó phân biệt bè; trong hợp xướng 4 bè nên giữ thứ tự S ≥ A ≥ T ≥ B.',
            { part: up.part, measureIndex: u2.measureIndex, noteIds: [u2.noteId, l2.noteId] });
        }
        if (j === i + 1 && up.role !== 'T' && u2.midi - l2.midi > 12) {
          add('harmony.spacing', 'info', `Khoảng cách ${up.role}–${lo.role} rộng hơn quãng 8.`,
            'Giữa S–A và A–T nên giữ trong quãng 8 để hợp âm hòa quyện; T–B có thể rộng hơn.',
            { part: up.part, measureIndex: u2.measureIndex, noteIds: [u2.noteId, l2.noteId] });
        }
        if (k === 0) continue;
        const u1 = mu.get(common[k - 1]!)!;
        const l1 = ml.get(common[k - 1]!)!;
        const i1 = mod(u1.midi - l1.midi, 12);
        const i2 = mod(u2.midi - l2.midi, 12);
        const du = u2.midi - u1.midi;
        const dl = l2.midi - l1.midi;
        if (du !== 0 && dl !== 0 && Math.sign(du) === Math.sign(dl) && i1 === i2 && (i1 === 7 || i1 === 0)) {
          add('harmony.parallel', 'suggestion',
            `Song song ${i1 === 7 ? 'quãng 5' : 'quãng 8/đồng âm'} giữa ${up.role} và ${lo.role}.`,
            'Hai bè đi cùng chiều giữ nguyên quãng đúng làm mất tính độc lập của bè (quy tắc hòa âm cổ điển). Có thể cho một bè đi ngược chiều.',
            { part: up.part, measureIndex: u2.measureIndex, noteIds: [u1.noteId, l1.noteId, u2.noteId, l2.noteId] });
        }
      }
    }
  }

  // ================= 3. Cấu trúc thánh ca
  const lastIdx = score.measures.length - 1;
  if (melody && melody.notes.length) {
    const last = melody.notes[melody.notes.length - 1]!;
    const t = tonicPc(score, last.measureIndex);
    if (mod(last.midi, 12) !== t) {
      add('structure.final-tonic', 'suggestion', `Giai điệu kết trên ${pitchName(last.pitch)}, chưa về chủ âm.`,
        'Bài thánh ca thường kết trọn trên bậc I (chủ âm) để tạo cảm giác hoàn tất, nghỉ yên — phù hợp lời "Amen" hay câu kết.',
        { part: melody.part, measureIndex: last.measureIndex, noteIds: [last.noteId] });
    }
    if (hymn) {
      const lo = Math.min(...melody.notes.map((n) => n.midi));
      const hi = Math.max(...melody.notes.map((n) => n.midi));
      if ((melody.role === 'melody' || melody.role === 'S') && (lo < CONGREGATION[0] - 2 || hi > CONGREGATION[1] + 2 || hi - lo > 14)) {
        add('range.congregation', 'info',
          `Giai điệu trải ${hi - lo} bán cung (${pitchName(melody.notes.find((n) => n.midi === lo)!.pitch)}–${pitchName(melody.notes.find((n) => n.midi === hi)!.pitch)}).`,
          'Cộng đoàn hát thoải mái nhất trong khoảng Đô4–Rê5 (tối đa khoảng quãng 9–10). Có thể chuyển giọng để đưa giai điệu vào vùng này.',
          { part: melody.part });
      }
      // cao trào
      const highest = melody.notes.filter((n) => n.midi === hi);
      const total = melody.notes[melody.notes.length - 1]!.end || 1;
      if (melody.notes.length >= 12) {
        if (highest.length > 3) {
          add('structure.climax', 'info', `Nốt cao nhất ${pitchName(highest[0]!.pitch)} xuất hiện ${highest.length} lần.`,
            'Một bài hay thường có một điểm cao trào rõ ràng, chỉ chạm nốt cao nhất 1–2 lần, thường ở khoảng 2/3 bài.',
            { part: melody.part, noteIds: highest.map((n) => n.noteId) });
        } else if (highest.every((n) => n.start < total * 0.3)) {
          add('structure.climax', 'info', 'Điểm cao nhất của giai điệu nằm ở đầu bài.',
            'Đặt cao trào ở khoảng 2/3 bài giúp bài hát có hướng phát triển và cảm xúc tăng dần.',
            { part: melody.part, noteIds: highest.map((n) => n.noteId) });
        }
      }
      // câu nhạc
      const phrases: LineNote[][] = [];
      let cur: LineNote[] = [];
      melody.notes.forEach((n, i) => {
        if (n.afterRest && cur.length) {
          phrases.push(cur);
          cur = [];
        }
        cur.push(n);
        if (n.phraseEnd || i === melody.notes.length - 1) {
          phrases.push(cur);
          cur = [];
        }
      });
      const barTicks = nominalMeasureTicks(score, 0);
      for (const ph of phrases) {
        if (ph.length < 3) continue;
        const bars = (ph[ph.length - 1]!.end - ph[0]!.start) / barTicks;
        const nearest = [2, 4, 8].reduce((a, b) => (Math.abs(b - bars) < Math.abs(a - bars) ? b : a));
        if (Math.abs(bars - nearest) > 0.75 && bars > 1) {
          add('structure.phrase-length', 'info', `Câu nhạc dài khoảng ${bars.toFixed(1)} ô nhịp.`,
            'Thánh ca truyền thống thường xây dựng câu 2–4 ô (đoạn 8 ô) cân phương, giúp cộng đoàn dễ nhớ và lấy hơi. Câu lẻ vẫn được nếu là chủ ý theo lời.',
            { part: melody.part, measureIndex: ph[0]!.measureIndex, noteIds: [ph[0]!.noteId, ph[ph.length - 1]!.noteId] });
        }
      }
      if (phrases.length >= 3) {
        const ends = phrases.slice(0, -1).map((p) => p[p.length - 1]!);
        if (ends.every((n) => mod(n.midi, 12) === tonicPc(score, n.measureIndex))) {
          add('structure.cadence-variety', 'info', 'Mọi câu nhạc đều kết về chủ âm.',
            'Xen kẽ kết lửng (bậc II, V, VII) ở câu giữa bài tạo cấu trúc hỏi–đáp, chỉ kết trọn ở cuối bài.',
            { part: melody.part, noteIds: ends.map((n) => n.noteId) });
        }
      }
    }
  }
  if (bass && bass.notes.length) {
    const last = bass.notes[bass.notes.length - 1]!;
    if (mod(last.midi, 12) !== tonicPc(score, last.measureIndex)) {
      add('structure.final-bass', 'suggestion', `Bè trầm kết trên ${pitchName(last.pitch)}, chưa về chủ âm.`,
        'Kết trọn (V–I) cần bè trầm về bậc I để bài kết vững.',
        { part: bass.part, measureIndex: last.measureIndex, noteIds: [last.noteId] });
    }
  }
  if (lastIdx >= 0 && score.measures[lastIdx]!.barlineRight !== 'final' && !score.measures[lastIdx]!.repeatEnd) {
    add('structure.final-barline', 'info', 'Ô cuối chưa có vạch kết bài.', 'Vạch kép kết (mảnh–đậm) báo hiệu kết thúc tác phẩm.',
      { measureIndex: lastIdx });
  }
  const first = score.measures[0];
  if (first?.pickup && first.actualTicks && lastIdx > 0) {
    const expect = nominalMeasureTicks(score, lastIdx) - first.actualTicks;
    for (const part of score.parts) {
      const voices = part.content[score.measures[lastIdx]!.id] ?? [];
      const v = voices[0];
      if (!v) continue;
      const t = eventTicksIn(score, lastIdx, v.events);
      // độ dài phần có nốt (bỏ dấu lặng cuối)
      let lastSound = 0;
      v.events.forEach((e, i) => { if (e.kind === 'chord') lastSound = t[i]!.start + t[i]!.ticks; });
      if (lastSound > 0 && lastSound > expect && measureTicks(score, lastIdx) === nominalMeasureTicks(score, lastIdx)) {
        add('structure.pickup-balance', 'info', 'Bài có ô lấy đà: ô cuối thường được rút ngắn tương ứng.',
          'Ô lấy đà + ô cuối = một ô đủ nhịp, giúp khi hát lặp lại các lời (phiên khúc) không bị dư phách.',
          { part, measureIndex: lastIdx });
        break;
      }
    }
  }

  // ================= 4. Lời ca tiếng Việt
  for (const line of lines) {
    const ns = line.notes;
    const withLyric = ns.filter((n) => n.event.lyrics.length > 0).length;
    if (withLyric === 0) continue;
    let prevSyl: { n: LineNote; text: string; tone: VietTone } | undefined;
    let inMelisma = false;
    let slur = false;
    for (const n of ns) {
      const syl = syllableOf(n);
      if (n.event.slurStart) slur = true;
      if (!syl) {
        if (withLyric / ns.length >= 0.5 && !inMelisma && !slur && n.event.lyrics.length === 0) {
          add('lyrics.missing', 'info', `${line.label}: nốt ${pitchName(n.pitch)} chưa có lời.`,
            'Nếu đây là luyến (melisma), hãy thêm dấu luyến hoặc gạch kéo dài lời để người hát biết ngân tiếp.',
            { part: line.part, measureIndex: n.measureIndex, noteIds: [n.noteId] });
        }
        if (n.event.slurStop) slur = false;
        continue;
      }
      const lyric = n.event.lyrics.find((l) => l.verse === 1)!;
      inMelisma = !!lyric.extend;
      if (n.event.slurStop) slur = false;
      if (prevSyl && !n.afterRest && !prevSyl.n.phraseEnd) {
        const d = n.midi - prevSyl.n.midi;
        const a = prevSyl.tone;
        const b = syl.tone;
        const low = (t: VietTone) => t === 'huyen' || t === 'nang';
        const high = (t: VietTone) => t === 'sac' || t === 'nga';
        let msg: string | undefined;
        if (low(b) && !low(a) && d >= toneTh) {
          msg = `"${syl.text}" (${TONE_LABEL[b]}) đặt cao hơn "${prevSyl.text}" ${d} bán cung — dễ nghe thành ${b === 'huyen' ? 'thanh ngang' : 'dấu sắc'}.`;
        } else if (high(b) && (low(a) || a === 'hoi') && d <= -toneTh) {
          msg = `"${syl.text}" (${TONE_LABEL[b]}) đặt thấp hơn "${prevSyl.text}" ${-d} bán cung — dễ nghe thành ${b === 'sac' ? 'dấu huyền/nặng' : 'dấu hỏi'}.`;
        } else if (b === 'ngang' && low(a) && d <= -(toneTh + 1)) {
          msg = `"${syl.text}" (thanh ngang) đi xuống ${-d} bán cung sau "${prevSyl.text}" (${TONE_LABEL[a]}) — có thể nghe như dấu huyền.`;
        }
        if (msg) {
          add('lyrics.tone-contour', 'suggestion', msg,
            'Tiếng Việt có thanh điệu: thanh huyền/nặng thấp, thanh sắc/ngã cao. Khi giai điệu đi ngược hướng thanh, người nghe dễ hiểu sai lời. Có thể đổi nốt, đổi chữ đồng nghĩa hoặc bỏ qua nếu là chủ ý.',
            { part: line.part, measureIndex: n.measureIndex, noteIds: [prevSyl.n.noteId, n.noteId] });
        }
      }
      prevSyl = { n, ...syl };
    }
  }

  // ================= 5. Ký âm
  for (const issue of validateScore(score)) {
    if (issue.code !== 'MEASURE_OVERFULL' && issue.code !== 'MEASURE_UNDERFULL') continue;
    const part = score.parts.find((p) => p.id === issue.partId);
    const mi = score.measures.findIndex((m) => m.id === issue.measureId);
    if (mi === 0 && score.measures[0]!.pickup) continue;
    add('notation.measure-fill', issue.code === 'MEASURE_OVERFULL' ? 'warning' : 'info', issue.message,
      'Tổng trường độ trong ô nhịp phải bằng số chỉ nhịp để phát nhạc và dàn trang đúng.', { part, measureIndex: mi });
  }

  const sevRank: Record<AdvisorSeverity, number> = { warning: 0, suggestion: 1, info: 2 };
  return out.sort((a, b) => (a.measureIndex ?? 1e9) - (b.measureIndex ?? 1e9) || sevRank[a.severity] - sevRank[b.severity]);
}

// ---------------------------------------------------------------- bỏ qua / tắt quy tắc (không phải thao tác âm nhạc → không vào undo)

export function dismissSuggestion(score: ScoreDocument, id: string): void {
  score.advisor ??= { dismissed: [], disabledRules: [] };
  if (!score.advisor.dismissed.includes(id)) score.advisor.dismissed.push(id);
}

export function restoreDismissed(score: ScoreDocument): void {
  if (score.advisor) score.advisor.dismissed = [];
}

export function setRuleEnabled(score: ScoreDocument, rule: AdvisorRule, enabled: boolean): void {
  score.advisor ??= { dismissed: [], disabledRules: [] };
  const set = new Set(score.advisor.disabledRules);
  if (enabled) set.delete(rule);
  else set.add(rule);
  score.advisor.disabledRules = [...set];
}
