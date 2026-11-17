/**
 * Giao diện nhà cung cấp AI (Phase 5). Không hardcode provider nào.
 * Desktop KHÔNG gọi provider trực tiếp và không giữ API secret: mọi job đi qua backend
 * (trừ credit, idempotency) rồi tới AI worker; worker dùng các adapter dưới đây.
 */
export interface SingingVoice {
  id: string;
  name: string;
  language: string[]; // vd ['vi']
  range: 'soprano' | 'alto' | 'tenor' | 'bass' | 'female' | 'male' | 'choir';
  previewUrl?: string;
}

export interface ProviderCapabilities {
  /** Tổng hợp giọng hát theo nốt + lời (bắt buộc cho Strict Melody Mode) */
  scoreConditionedSinging: boolean;
  vietnamese: boolean;
  perWordPronunciation: boolean;
  stems: ('vocal' | 'instrumental' | 'full_mix')[];
  progressReporting: boolean;
}

export interface SingingRequest {
  musicXml: string;
  melodyPartId: string;
  verse: number;
  voiceId: string;
  tempoBpm?: number;
  /** Ghi đè phát âm theo âm tiết (lyric id → phiên âm) */
  pronunciation?: Record<string, string>;
}

export interface AudioArtifact {
  kind: 'vocal' | 'instrumental' | 'full_mix';
  path: string;
  format: 'wav' | 'flac' | 'mp3';
  durationSec: number;
}

export interface SingingProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  voices(): Promise<SingingVoice[]>;
  render(req: SingingRequest, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<AudioArtifact[]>;
}

export interface HarmonyProvider {
  readonly id: string;
  /** Trả về cùng định dạng HarmonyVariant với bộ gợi ý cục bộ của music-core */
  suggest(req: { musicXml: string; melodyPartId: string; style: string; measureRange?: [number, number] }, signal: AbortSignal): Promise<unknown[]>;
}

/** Strict Melody Mode chỉ được bật khi provider khai báo năng lực tương ứng */
export function supportsStrictMelody(c: ProviderCapabilities): boolean {
  return c.scoreConditionedSinging;
}
