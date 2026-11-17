/**
 * Canonical Score Model — nguồn dữ liệu duy nhất cho Player, Score Editor và AI Singer.
 *
 * Quy ước:
 *  - Thời gian là tick nguyên, TICKS_PER_QUARTER = 480.
 *  - Cao độ lưu theo **cao độ viết** (written pitch) của từng part; part.instrument.transpose
 *    cho biết cách đổi sang cao độ thực (sounding = written + transpose), giống MusicXML.
 *  - keyMap lưu theo **concert pitch**.
 *  - Mọi phần tử có `id` ổn định, không đổi khi chỉnh sửa.
 */

export const TICKS_PER_QUARTER = 480;

export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

export interface Pitch {
  step: Step;
  /** -2..2 (bb, b, natural, #, x) */
  alter: number;
  /** Octave khoa học: C4 = đô giữa */
  octave: number;
}

export type DurationType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd' | '64th';

export interface Tuplet {
  /** Số nốt thực tế (vd 3 trong liên ba) */
  actual: number;
  /** Chiếm chỗ của bao nhiêu nốt thường (vd 2) */
  normal: number;
}

export interface Duration {
  type: DurationType;
  dots: number;
  tuplet?: Tuplet;
}

export type Syllabic = 'single' | 'begin' | 'middle' | 'end';

export interface Lyric {
  id: string;
  /** Lời thứ mấy (1 = phiên khúc 1) */
  verse: number;
  text: string;
  syllabic: Syllabic;
  /** Melisma: kéo dài âm tiết qua các nốt sau */
  extend?: boolean;
  /** Dịch ngang thủ công (đơn vị: khoảng dòng kẻ) */
  offsetX?: number;
}

export type AccidentalDisplay = 'auto' | 'show' | 'hide' | 'cautionary';

export interface Note {
  id: string;
  pitch: Pitch;
  tieStart?: boolean;
  tieStop?: boolean;
  accidentalDisplay?: AccidentalDisplay;
  /** File nguồn có ký hiệu dấu hoá viết riêng cho nốt này (dùng khi hiệu chỉnh OMR) */
  writtenAccidental?: boolean;
  /** 0..1 độ tin cậy, chỉ có khi dữ liệu tạo từ OMR */
  omrConfidence?: number;
}

export type Articulation = 'staccato' | 'accent' | 'tenuto' | 'marcato' | 'staccatissimo' | 'fermata';

/** Láy (ornament) */
export type Ornament = 'trill' | 'mordent' | 'inverted-mordent' | 'turn' | 'inverted-turn';

interface EventBase {
  id: string;
  duration: Duration;
  /** Chỉ số khuông trong part (0-based) */
  staff: number;
  omrConfidence?: number;
}

export interface ChordEvent extends EventBase {
  kind: 'chord';
  /** Một nốt đơn là chord có 1 note */
  notes: Note[];
  lyrics: Lyric[];
  articulations: Articulation[];
  ornaments?: Ornament[];
  slurStart?: boolean;
  slurStop?: boolean;
  /** Nốt hoa mỹ; 'slash' = acciaccatura (có gạch chéo), 'plain' = appoggiatura */
  grace?: boolean;
  graceSlash?: boolean;
}

export interface RestEvent extends EventBase {
  kind: 'rest';
  /** Dấu lặng nguyên ô nhịp */
  measureRest?: boolean;
  hidden?: boolean;
}

export type MusicEvent = ChordEvent | RestEvent;

export interface Voice {
  id: string;
  /** 1-based, theo MusicXML */
  number: number;
  events: MusicEvent[];
}

export interface Clef {
  sign: 'G' | 'F' | 'C' | 'percussion';
  line: number;
  octaveChange?: number;
}

export interface Staff {
  id: string;
  clef: Clef;
}

export interface Instrument {
  name: string;
  /** General MIDI program 0..127 */
  program: number;
  /** MIDI channel 0..15 */
  channel: number;
  /** sounding = written + transpose */
  transposeChromatic: number;
  transposeDiatonic: number;
}

export interface Part {
  id: string;
  name: string;
  abbreviation: string;
  instrument: Instrument;
  staves: Staff[];
  /** Nội dung theo measure id */
  content: Record<string, Voice[]>;
}

export interface Volta {
  numbers: number[];
  /** Ô cuối của volta có đóng ngoặc không */
  closed: boolean;
}

export type Barline = 'regular' | 'double' | 'final' | 'dashed' | 'none';

export interface Measure {
  id: string;
  /** Số hiển thị */
  number: string;
  /** Ô nhịp lấy đà (độ dài có thể ngắn hơn số chỉ nhịp) */
  pickup?: boolean;
  /** Độ dài thực của ô lấy đà, ticks */
  actualTicks?: number;
  barlineRight: Barline;
  repeatStart?: boolean;
  repeatEnd?: boolean;
  repeatTimes?: number;
  volta?: Volta;
  systemBreak?: boolean;
  pageBreak?: boolean;
  rehearsalMark?: string;
}

export interface KeySig {
  measureIndex: number;
  /** -7..7, theo concert pitch */
  fifths: number;
  mode: 'major' | 'minor';
}

export interface TimeSig {
  measureIndex: number;
  beats: number;
  beatType: number;
}

export interface TempoMark {
  measureIndex: number;
  /** offset trong ô nhịp, ticks */
  offset: number;
  /** quarter-note BPM */
  bpm: number;
  text?: string;
}

export type ChordKind =
  | 'major' | 'minor' | 'diminished' | 'augmented'
  | 'dominant' | 'major-seventh' | 'minor-seventh' | 'half-diminished' | 'diminished-seventh'
  | 'suspended-fourth' | 'suspended-second' | 'major-sixth' | 'minor-sixth' | 'power';

export interface PitchClass {
  step: Step;
  alter: number;
}

export interface ChordSymbol {
  id: string;
  partId: string;
  measureId: string;
  offset: number;
  root: PitchClass;
  kind: ChordKind;
  bass?: PitchClass;
}

export type DynamicMark = 'ppp' | 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'fff' | 'sf' | 'sfz' | 'fp';

export interface DynamicEvent {
  id: string;
  partId: string;
  measureId: string;
  offset: number;
  mark: DynamicMark;
}

export type PageSize = 'A4' | 'A5' | 'Letter' | 'Custom';

export interface LayoutSettings {
  pageSize: PageSize;
  /** mm, chỉ dùng khi Custom */
  pageWidthMm: number;
  pageHeightMm: number;
  orientation: 'portrait' | 'landscape';
  marginsMm: { top: number; bottom: number; left: number; right: number };
  /** Khoảng cách giữa 2 dòng kẻ khuông, mm */
  staffSpaceMm: number;
  staffSpacing: number;
  systemSpacing: number;
  measuresPerSystem?: number;
  firstSystemIndentMm: number;
  preset: 'compact' | 'standard' | 'professional' | 'hymnal' | 'choir' | 'lead-sheet';
  showPageNumbers: boolean;
  header?: string;
  footer?: string;
  lyricFont: string;
  lyricFontSizePt: number;
  /** Khoảng cách từ dòng kẻ dưới cùng tới dòng lời 1 (đơn vị: khoảng dòng kẻ) */
  lyricOffsetSp?: number;
  /** Khoảng cách giữa các lời (phiên khúc) */
  lyricVerseSpacingSp?: number;
  lyricItalicVerses?: number[];
  showVerseNumbers?: boolean;
}

export interface MixerChannel {
  partId: string;
  volume: number; // 0..1
  pan: number; // -1..1
  reverb: number; // 0..1
  chorus: number; // 0..1
  mute: boolean;
  solo: boolean;
}

export interface PlaybackSettings {
  soundFont: string;
  speed: number; // 0.25..4
  transposeSemitones: number;
  metronome: boolean;
  countInBars: number;
  mixer: MixerChannel[];
}

export interface ScoreMeta {
  title: string;
  subtitle: string;
  composer: string;
  lyricist: string;
  arranger: string;
  copyright: string;
}

export interface AiMeta {
  /** Lịch sử job AI gắn với bản nhạc (chỉ tham chiếu, không chứa dữ liệu audio) */
  jobs: { jobId: string; type: string; createdAt: string; scoreRevision: number }[];
}

export interface Provenance {
  source: 'new' | 'musicxml' | 'midi' | 'omr';
  /** Với OMR: các event chưa được người dùng xác minh */
  unverifiedEventIds: string[];
}

export interface ScoreDocument {
  schemaVersion: 1;
  id: string;
  revision: number;
  meta: ScoreMeta;
  parts: Part[];
  measures: Measure[];
  keyMap: KeySig[];
  timeSigMap: TimeSig[];
  tempoMap: TempoMark[];
  chordSymbols: ChordSymbol[];
  dynamics: DynamicEvent[];
  layout: LayoutSettings;
  playback: PlaybackSettings;
  aiMeta: AiMeta;
  provenance: Provenance;
  /** Trạng thái Trợ lý soạn nhạc: gợi ý người dùng đã bỏ qua, quy tắc đã tắt */
  advisor?: AdvisorState;
  /** Bản nhạc mở từ ảnh/PDF: ảnh trang gốc, tọa độ từng ô nhịp, kết quả đối chiếu thủ công */
  sheet?: SheetSource;
}

/** Hình chữ nhật trên ảnh trang gốc, đơn vị = tỉ lệ 0..1 theo chiều rộng/cao trang (không phụ thuộc độ phân giải) */
export interface SheetBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetPage {
  /** Tên file ảnh trong gói dự án .holymelody, vd pages/1.png */
  file: string;
  /** Kích thước ảnh, px */
  width: number;
  height: number;
}

export interface SheetMeasureGeom extends SheetBox {
  measureIndex: number;
  /** Chỉ số hệ thống (dòng nhạc) trên toàn bài */
  system: number;
  /** Vị trí nốt theo thời gian: [tick trong ô nhịp, x tỉ lệ trang] — để con trỏ chạy đúng trên ảnh */
  ticks: [number, number][];
}

export interface OmrSignal {
  measureIndex: number;
  code: 'KEY_SUSPECT' | 'LOW_GRADE';
  message: string;
}

export type ReviewStatus = 'confirmed' | 'corrected' | 'rerecognized' | 'flagged';

/** Kết quả đối chiếu (human-in-the-loop) một ô nhịp, lưu vĩnh viễn trong dự án */
export interface MeasureReview {
  measureId: string;
  status: ReviewStatus;
  box: SheetBox;
  /** Mã lỗi Validator còn lại lúc người dùng xác nhận */
  issues: string[];
  /** Cách nhận dạng ra kết quả cuối: audiveris | audiveris-region:<cấu hình> | ai:<mô hình> | manual */
  engine: string;
  at: string;
}

export interface SheetSource {
  kind: 'image' | 'pdf';
  fileName: string;
  /** SHA-256 của file gốc: khoá để trừ credit đúng một lần cho mỗi bản nhạc */
  hash: string;
  pages: SheetPage[];
  measures: SheetMeasureGeom[];
  /** overlay: chỉ phủ lớp nhận dạng lên ảnh để phát MIDI; edit: đã dựng khuông nhạc đầy đủ để biên tập */
  mode: 'overlay' | 'edit';
  conversion?: { at: string; credits: number; transactionId?: number };
  /** Vùng khó phát hiện từ dữ liệu Audiveris + ảnh nhị phân (điểm tin cậy thấp, nghi sót hoá biểu…) */
  signals?: OmrSignal[];
  reviews: Record<string, MeasureReview>;
}

export interface AdvisorState {
  dismissed: string[];
  disabledRules: string[];
}
