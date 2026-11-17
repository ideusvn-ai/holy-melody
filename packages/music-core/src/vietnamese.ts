/**
 * Xử lý tiếng Việt cho lời ca: tách âm tiết, nhận dạng dấu thanh.
 */

export type VietTone = 'ngang' | 'huyen' | 'sac' | 'hoi' | 'nga' | 'nang';

export const TONE_LABEL: Record<VietTone, string> = {
  ngang: 'thanh ngang',
  huyen: 'dấu huyền',
  sac: 'dấu sắc',
  hoi: 'dấu hỏi',
  nga: 'dấu ngã',
  nang: 'dấu nặng',
};

const TONE_MARKS: Record<string, VietTone> = {
  '̀': 'huyen',
  '́': 'sac',
  '̉': 'hoi',
  '̃': 'nga',
  '̣': 'nang',
};

/** Nhận dạng thanh điệu của một âm tiết (đã bỏ dấu câu). */
export function detectTone(syllable: string): VietTone {
  for (const ch of syllable.normalize('NFD')) {
    const t = TONE_MARKS[ch];
    if (t) return t;
  }
  return 'ngang';
}

/** Âm tiết có chứa chữ cái không (để bỏ qua "-", "_", dấu câu đứng riêng) */
export function isSyllable(s: string): boolean {
  return /\p{L}/u.test(s);
}

/**
 * Độ cao tương đối khi nói của 6 thanh (thang 1–5, theo mô tả ngữ âm học phổ biến):
 * ngang cao-bằng, huyền thấp-xuống, sắc cao-lên, hỏi thấp-xuống-lên, ngã cao-gãy-lên, nặng thấp-tắc.
 */
export const TONE_HEIGHT: Record<VietTone, number> = {
  huyen: 1,
  nang: 1,
  hoi: 2,
  ngang: 3,
  nga: 4,
  sac: 5,
};

/** Tách một dòng lời thành âm tiết (tiếng Việt: mỗi khoảng trắng là một âm tiết). Dấu "_" nối melisma. */
export function splitSyllables(line: string): string[] {
  return line
    .normalize('NFC')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Bỏ dấu câu đầu/cuối âm tiết */
export function stripPunctuation(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Âm tiết kết thúc câu (có dấu câu) → gợi ý ranh giới câu nhạc */
export function endsPhrase(s: string): boolean {
  return /[.,;:!?…]$/.test(s.trim());
}
