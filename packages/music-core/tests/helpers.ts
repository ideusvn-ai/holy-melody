import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  chord, createScore, parsePitchName, rest, type Duration, type MusicEvent, type ScoreDocument, type Syllabic,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

export const q: Duration = { type: 'quarter', dots: 0 };
export const h: Duration = { type: 'half', dots: 0 };
export const w: Duration = { type: 'whole', dots: 0 };
export const e8: Duration = { type: 'eighth', dots: 0 };

/** "C4:q:Lạy G4:h - :q" → events. "-" = dấu lặng */
export function seq(spec: string): MusicEvent[] {
  return spec.trim().split(/\s+/).map((tok) => {
    const [p, d = 'q', lyric] = tok.split(':');
    const dur = ({ q, h, w, e: e8, 'h.': { type: 'half', dots: 1 }, 'q.': { type: 'quarter', dots: 1 } } as Record<string, Duration>)[d]!;
    if (p === '-') return rest(dur);
    const ev = chord(p!.split('+').map(parsePitchName), dur);
    if (lyric) ev.lyrics.push({ id: `l_${ev.id}`, verse: 1, text: lyric.normalize('NFC'), syllabic: 'single' as Syllabic });
    return ev;
  });
}

/** Tạo bài với các part, mỗi part là danh sách ô nhịp dạng chuỗi */
export function buildScore(
  parts: { name: string; clef?: 'G' | 'F'; measures: string[] }[],
  opts: { keyFifths?: number; beats?: number; bpm?: number } = {},
): ScoreDocument {
  const n = Math.max(...parts.map((p) => p.measures.length));
  const s = createScore({
    parts: parts.map((p) => ({ name: p.name, clefs: [p.clef === 'F' ? { sign: 'F', line: 4 } : { sign: 'G', line: 2 }] })),
    measures: n,
    keyFifths: opts.keyFifths ?? 0,
    beats: opts.beats ?? 4,
    bpm: opts.bpm ?? 120,
  });
  parts.forEach((p, pi) => {
    p.measures.forEach((m, mi) => {
      s.parts[pi]!.content[s.measures[mi]!.id]![0]!.events = seq(m);
    });
  });
  s.measures[n - 1]!.barlineRight = 'final';
  return s;
}
