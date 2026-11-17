/**
 * Giao diện OMR (Phase 4). Engine chạy ngoài UI thread (tiến trình con / worker).
 * Không giả định mọi PDF đều trích được MusicXML: phân loại đầu vào trước.
 */
export type OmrInputKind = 'pdf-vector' | 'pdf-scanned' | 'image' | 'pdf-embedded-musicxml';

export type OmrStage =
  | 'read' | 'page-analysis' | 'staff-detection' | 'clef-detection' | 'notes-accidentals'
  | 'durations-rests' | 'meter-barlines' | 'lyrics' | 'musicxml' | 'validation';

export interface OmrProgress {
  stage: OmrStage;
  page: number;
  pages: number;
  /** 0..1 */
  fraction: number;
}

export interface OmrRegionConfidence {
  page: number;
  /** khung theo pixel ảnh gốc */
  bbox: [number, number, number, number];
  measureIndex?: number;
  confidence: number;
  reason?: string;
}

export interface OmrResult {
  musicXml: string;
  regions: OmrRegionConfidence[];
  warnings: string[];
  engine: string;
  engineVersion: string;
}

export interface OmrEngine {
  readonly id: string;
  readonly name: string;
  /** Giấy phép của engine – hiển thị cho người dùng trước khi cài */
  readonly license: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  recognize(input: { path: string; kind: OmrInputKind; pages?: number[] }, onProgress: (p: OmrProgress) => void, signal: AbortSignal): Promise<OmrResult>;
}
