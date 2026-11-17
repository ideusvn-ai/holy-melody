/** Sinh ID ổn định. ID chỉ được tạo một lần khi phần tử ra đời và không bao giờ đổi. */

export type IdPrefix = 'sc' | 'p' | 'st' | 'm' | 'v' | 'e' | 'n' | 'l' | 'ch' | 'dy';

type Generator = (prefix: IdPrefix) => string;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomGenerator(prefix: IdPrefix): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

let current: Generator = randomGenerator;

export function newId(prefix: IdPrefix): string {
  return current(prefix);
}

/** Dùng trong test để có ID xác định. Trả về hàm khôi phục. */
export function useDeterministicIds(): () => void {
  const counters = new Map<string, number>();
  current = (prefix) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_${n}`;
  };
  return () => {
    current = randomGenerator;
  };
}

/** MusicXML yêu cầu ID hợp lệ kiểu XML NCName. */
export function isValidXmlId(id: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id);
}
