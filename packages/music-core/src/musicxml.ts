/**
 * MusicXML (score-partwise) ⇄ Canonical Score Model.
 * ID của note/measure được ghi vào thuộc tính `id` (MusicXML 4.0) để giữ ổn định qua lần xuất/nhập.
 */
import { exactDurationForTicks, ticksToDurations } from './duration.js';
import { isValidXmlId, newId } from './ids.js';
import {
  TICKS_PER_QUARTER,
  type Articulation, type Barline, type ChordEvent, type ChordKind, type ChordSymbol, type DurationType,
  type DynamicMark, type Duration, type MusicEvent, type Ornament, type Part, type ScoreDocument, type Step, type Syllabic, type Voice,
} from './model.js';
import { fifthsOfInterval, keyAlterFor } from './pitch.js';
import { createScore, eventTicksIn, keyAt, measureTicks, nominalMeasureTicks, rest, timeSigAt } from './score.js';
import { child, childNum, childText, el, kids, parseXml, serializeXml, tel, text, type XmlElement, type XmlNode } from './xml.js';

const DURATION_TYPES = new Set<DurationType>(['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th']);
const ARTICULATIONS = new Set<Articulation>(['staccato', 'accent', 'tenuto', 'staccatissimo']);
const ORNAMENTS = new Set<Ornament>(['trill', 'mordent', 'inverted-mordent', 'turn', 'inverted-turn']);
const DYNAMICS = new Set<DynamicMark>(['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sf', 'sfz', 'fp']);
const CHORD_KINDS = new Set<ChordKind>([
  'major', 'minor', 'diminished', 'augmented', 'dominant', 'major-seventh', 'minor-seventh',
  'half-diminished', 'diminished-seventh', 'suspended-fourth', 'suspended-second', 'major-sixth', 'minor-sixth', 'power',
]);

export class MusicXmlError extends Error {}

const keepId = (id: string | undefined, prefix: Parameters<typeof newId>[0], used: Set<string>): string => {
  if (id && isValidXmlId(id) && !used.has(id)) {
    used.add(id);
    return id;
  }
  const g = newId(prefix);
  used.add(g);
  return g;
};

// ====================================================================== IMPORT

export function importMusicXml(xml: string): ScoreDocument {
  const root = parseXml(xml);
  if (root.name === 'score-timewise') throw new MusicXmlError('score-timewise chưa được hỗ trợ; hãy xuất dạng partwise');
  if (root.name !== 'score-partwise') throw new MusicXmlError(`Không phải MusicXML: <${root.name}>`);

  const score = createScore({ parts: [], measures: 0 });
  score.provenance.source = 'musicxml';
  score.keyMap = [];
  score.timeSigMap = [];
  score.tempoMap = [];
  score.playback.mixer = [];
  const used = new Set<string>();

  // ---- metadata
  score.meta.title = childText(child(root, 'work'), 'work-title') ?? childText(root, 'movement-title') ?? 'Untitled';
  const ident = child(root, 'identification');
  for (const c of kids(ident, 'creator')) {
    const t = c.attrs.type;
    const v = text(c).trim();
    if (t === 'composer') score.meta.composer = v;
    else if (t === 'lyricist' || t === 'poet') score.meta.lyricist = v;
    else if (t === 'arranger') score.meta.arranger = v;
  }
  score.meta.copyright = childText(ident, 'rights') ?? '';
  const lf = child(child(root, 'defaults'), 'lyric-font');
  if (lf?.attrs['font-family']) score.layout.lyricFont = lf.attrs['font-family'].split(',')[0]!.trim();
  if (lf?.attrs['font-size'] && Number(lf.attrs['font-size']) > 0) score.layout.lyricFontSizePt = Number(lf.attrs['font-size']);

  // ---- part-list
  const partList = child(root, 'part-list');
  const partMeta = new Map<string, Part>();
  for (const sp of kids(partList, 'score-part')) {
    const midi = child(sp, 'midi-instrument');
    const name = childText(sp, 'part-name') ?? 'Part';
    const p: Part = {
      id: keepId(sp.attrs.id, 'p', used),
      name,
      abbreviation: childText(sp, 'part-abbreviation') ?? '',
      instrument: {
        name: childText(child(sp, 'score-instrument'), 'instrument-name') ?? name,
        program: Math.max(0, (childNum(midi, 'midi-program') ?? 1) - 1),
        channel: Math.max(0, (childNum(midi, 'midi-channel') ?? partMeta.size + 1) - 1),
        transposeChromatic: 0,
        transposeDiatonic: 0,
      },
      staves: [],
      content: {},
    };
    partMeta.set(sp.attrs.id ?? p.id, p);
  }

  const xmlParts = kids(root, 'part');
  if (xmlParts.length === 0) throw new MusicXmlError('Không có <part>');

  xmlParts.forEach((xp, partIndex) => {
    const part = partMeta.get(xp.attrs.id ?? '') ?? {
      id: keepId(xp.attrs.id, 'p', used), name: `Part ${partIndex + 1}`, abbreviation: '',
      instrument: { name: 'Piano', program: 0, channel: partIndex, transposeChromatic: 0, transposeDiatonic: 0 },
      staves: [], content: {},
    };
    score.parts.push(part);
    score.playback.mixer.push({ partId: part.id, volume: 0.8, pan: 0, reverb: 0.2, chorus: 0, mute: false, solo: false });
    importPart(score, part, xp, partIndex === 0, used);
  });

  if (score.keyMap.length === 0) score.keyMap.push({ measureIndex: 0, fifths: 0, mode: 'major' });
  if (score.timeSigMap.length === 0) score.timeSigMap.push({ measureIndex: 0, beats: 4, beatType: 4 });
  if (score.tempoMap.length === 0) score.tempoMap.push({ measureIndex: 0, offset: 0, bpm: 100 });
  return score;
}

function importPart(score: ScoreDocument, part: Part, xp: XmlElement, isFirst: boolean, used: Set<string>) {
  let divisions = 1;
  const toTicks = (d: number) => Math.round((d * TICKS_PER_QUARTER) / divisions);
  let lastKeyWritten: number | undefined;

  kids(xp, 'measure').forEach((xm, mi) => {
    // ---- measure (part đầu tiên định nghĩa danh sách ô nhịp)
    if (isFirst) {
      score.measures.push({
        id: keepId(xm.attrs.id, 'm', used),
        number: xm.attrs.number ?? String(mi + 1),
        barlineRight: 'regular',
        pickup: xm.attrs.implicit === 'yes' && mi === 0 ? true : undefined,
      });
    }
    const measure = score.measures[mi];
    if (!measure) return; // part dài hơn part đầu: bỏ qua phần thừa
    const voices = new Map<number, Voice>();
    const voiceEnd = new Map<number, number>();
    let pos = 0;
    let maxPos = 0;

    const getVoice = (num: number, staff: number): Voice => {
      let v = voices.get(num);
      if (!v) {
        v = { id: newId('v'), number: num, events: [] };
        voices.set(num, v);
        voiceEnd.set(num, 0);
      }
      // lấp khoảng trống (do <forward> hoặc voice bắt đầu muộn) bằng dấu lặng ẩn
      const end = voiceEnd.get(num)!;
      if (pos > end) {
        for (const d of ticksToDurations(pos - end)) v.events.push(rest(d, staff, { hidden: true }));
        voiceEnd.set(num, pos);
      }
      return v;
    };

    for (const node of kids(xm)) {
      switch (node.name) {
        case 'attributes': {
          const div = childNum(node, 'divisions');
          if (div) divisions = div;
          const staves = childNum(node, 'staves');
          if (staves) while (part.staves.length < staves) part.staves.push({ id: newId('st'), clef: { sign: 'G', line: 2 } });
          if (part.staves.length === 0) part.staves.push({ id: newId('st'), clef: { sign: 'G', line: 2 } });
          for (const c of kids(node, 'clef')) {
            const idx = Number(c.attrs.number ?? 1) - 1;
            while (part.staves.length <= idx) part.staves.push({ id: newId('st'), clef: { sign: 'G', line: 2 } });
            const sign = (childText(c, 'sign') ?? 'G') as 'G' | 'F' | 'C' | 'percussion';
            part.staves[idx]!.clef = {
              sign: sign === ('TAB' as string) ? 'G' : sign,
              line: childNum(c, 'line') ?? (sign === 'F' ? 4 : sign === 'C' ? 3 : 2),
              octaveChange: childNum(c, 'clef-octave-change'),
            };
          }
          const tr = child(node, 'transpose');
          if (tr) {
            part.instrument.transposeChromatic = (childNum(tr, 'chromatic') ?? 0) + 12 * (childNum(tr, 'octave-change') ?? 0);
            part.instrument.transposeDiatonic = (childNum(tr, 'diatonic') ?? 0) + 7 * (childNum(tr, 'octave-change') ?? 0);
          }
          const key = child(node, 'key');
          if (key && isFirst) {
            const written = childNum(key, 'fifths') ?? 0;
            const instrFifths = instrumentFifths(part);
            const concert = written + instrFifths;
            if (lastKeyWritten !== written) {
              score.keyMap.push({ measureIndex: mi, fifths: concert, mode: childText(key, 'mode') === 'minor' ? 'minor' : 'major' });
              lastKeyWritten = written;
            }
          }
          const time = child(node, 'time');
          if (time && isFirst) {
            const beats = Number((childText(time, 'beats') ?? '4').split('+').reduce((a, b) => a + Number(b), 0));
            score.timeSigMap.push({ measureIndex: mi, beats, beatType: childNum(time, 'beat-type') ?? 4 });
          }
          break;
        }
        case 'backup':
          pos -= toTicks(childNum(node, 'duration') ?? 0);
          if (pos < 0) pos = 0;
          break;
        case 'forward':
          pos += toTicks(childNum(node, 'duration') ?? 0);
          maxPos = Math.max(maxPos, pos);
          break;
        case 'note': {
          if (part.staves.length === 0) part.staves.push({ id: newId('st'), clef: { sign: 'G', line: 2 } });
          const isChordTone = !!child(node, 'chord');
          const isGrace = !!child(node, 'grace');
          const vnum = Number(childText(node, 'voice') ?? 1);
          const staff = Math.max(0, Number(childText(node, 'staff') ?? 1) - 1);
          const durTicks = isGrace ? 0 : toTicks(childNum(node, 'duration') ?? 0);
          const pitchEl = child(node, 'pitch');
          const restEl = child(node, 'rest');

          if (isChordTone && pitchEl) {
            const v = voices.get(vnum);
            const last = v?.events[v.events.length - 1];
            if (last && last.kind === 'chord') {
              last.notes.push(readNote(node, pitchEl, used));
              break;
            }
          }
          const v = getVoice(vnum, staff);
          const duration = readDuration(node, durTicks);
          let ev: MusicEvent;
          if (restEl || !pitchEl) {
            ev = rest(duration, staff, {
              id: keepId(node.attrs.id, 'e', used),
              measureRest: restEl?.attrs.measure === 'yes' ? true : undefined,
            });
          } else {
            const n = readNote(node, pitchEl, used);
            const notations = child(node, 'notations');
            const arts: Articulation[] = [];
            for (const a of kids(child(notations, 'articulations'))) {
              if (ARTICULATIONS.has(a.name as Articulation)) arts.push(a.name as Articulation);
              else if (a.name === 'strong-accent') arts.push('marcato');
            }
            const orns: Ornament[] = [];
            for (const o of kids(child(notations, 'ornaments'))) {
              const name = o.name === 'trill-mark' ? 'trill' : o.name;
              if (ORNAMENTS.has(name as Ornament)) orns.push(name as Ornament);
            }
            if (child(notations, 'fermata')) arts.push('fermata');
            const slurs = kids(notations, 'slur');
            ev = {
              kind: 'chord',
              id: `e${n.id}`,
              duration,
              staff,
              notes: [n],
              lyrics: kids(node, 'lyric').map((l) => ({
                id: keepId(l.attrs.id, 'l', used),
                verse: Number(l.attrs.number ?? 1) || 1,
                text: kids(l, 'text').map((t) => text(t)).join(''),
                syllabic: (childText(l, 'syllabic') ?? 'single') as Syllabic,
                extend: child(l, 'extend') ? true : undefined,
                offsetX: l.attrs['relative-x'] ? Number(l.attrs['relative-x']) / 10 : undefined,
              })),
              articulations: arts,
              ornaments: orns.length ? orns : undefined,
              slurStart: slurs.some((s) => s.attrs.type === 'start') || undefined,
              slurStop: slurs.some((s) => s.attrs.type === 'stop') || undefined,
              grace: isGrace || undefined,
              graceSlash: isGrace && child(node, 'grace')?.attrs.slash === 'yes' ? true : undefined,
            };
          }
          v.events.push(ev);
          if (!isGrace) {
            pos += durTicks;
            voiceEnd.set(vnum, pos);
            maxPos = Math.max(maxPos, pos);
          }
          break;
        }
        case 'harmony': {
          const r = child(node, 'root');
          if (!r) break;
          const kind = (childText(node, 'kind') ?? 'major') as ChordKind;
          const b = child(node, 'bass');
          const cs: ChordSymbol = {
            id: keepId(node.attrs.id, 'ch', used),
            partId: part.id,
            measureId: measure.id,
            offset: pos + toTicks(childNum(node, 'offset') ?? 0),
            root: { step: (childText(r, 'root-step') ?? 'C') as Step, alter: childNum(r, 'root-alter') ?? 0 },
            kind: CHORD_KINDS.has(kind) ? kind : 'major',
            bass: b ? { step: (childText(b, 'bass-step') ?? 'C') as Step, alter: childNum(b, 'bass-alter') ?? 0 } : undefined,
          };
          score.chordSymbols.push(cs);
          break;
        }
        case 'direction':
        case 'sound': {
          const snd = node.name === 'sound' ? node : child(node, 'sound');
          const offset = pos + toTicks(childNum(node, 'offset') ?? 0);
          if (snd?.attrs.tempo && isFirst) {
            const words = text(child(child(node, 'direction-type'), 'words')).trim();
            score.tempoMap.push({ measureIndex: mi, offset, bpm: Number(snd.attrs.tempo), text: words || undefined });
          }
          for (const dt of kids(node, 'direction-type')) {
            for (const d of kids(child(dt, 'dynamics'))) {
              if (DYNAMICS.has(d.name as DynamicMark)) {
                score.dynamics.push({ id: newId('dy'), partId: part.id, measureId: measure.id, offset, mark: d.name as DynamicMark });
              }
            }
            const reh = childText(dt, 'rehearsal');
            if (reh && isFirst) measure.rehearsalMark = reh;
          }
          break;
        }
        case 'barline': {
          if (!isFirst) break;
          const loc = node.attrs.location ?? 'right';
          const style = childText(node, 'bar-style');
          const rep = child(node, 'repeat');
          const ending = child(node, 'ending');
          if (rep?.attrs.direction === 'forward') measure.repeatStart = true;
          if (rep?.attrs.direction === 'backward') {
            measure.repeatEnd = true;
            if (rep.attrs.times) measure.repeatTimes = Number(rep.attrs.times);
          }
          if (ending) {
            const nums = (ending.attrs.number ?? '1').split(/[,\s]+/).filter(Boolean).map(Number);
            if (ending.attrs.type === 'start') measure.volta = { numbers: nums, closed: false };
            else if (measure.volta || ending.attrs.type === 'stop' || ending.attrs.type === 'discontinue') {
              measure.volta = { numbers: measure.volta?.numbers ?? nums, closed: ending.attrs.type === 'stop' };
            }
          }
          if (loc === 'right' && style) {
            const map: Record<string, Barline> = { 'light-light': 'double', 'light-heavy': 'final', dashed: 'dashed', none: 'none', regular: 'regular' };
            measure.barlineRight = map[style] ?? 'regular';
          }
          break;
        }
        case 'print':
          if (isFirst && mi > 0) {
            if (node.attrs['new-system'] === 'yes') measure.systemBreak = true;
            if (node.attrs['new-page'] === 'yes') measure.pageBreak = true;
          }
          break;
      }
    }

    // ---- kết thúc ô nhịp
    if (isFirst && measure.pickup) {
      const nominal = nominalMeasureTicks(score, mi);
      if (maxPos > 0 && maxPos < nominal) measure.actualTicks = maxPos;
      else measure.pickup = undefined;
    }
    const expected = measureTicks(score, mi);
    const list = [...voices.values()].sort((a, b) => a.number - b.number);
    for (const v of list) {
      // dấu lặng duy nhất dài bằng cả ô → dấu lặng nguyên ô
      const only = v.events[0];
      if (v.events.length === 1 && only?.kind === 'rest' && !only.measureRest) {
        const t = eventTicksIn(score, mi, v.events)[0]!.ticks;
        if (t === expected) only.measureRest = true;
      }
      if (only?.kind === 'rest' && only.measureRest) only.duration = { type: 'whole', dots: 0 };
    }
    if (list.length === 0) {
      list.push({ id: newId('v'), number: 1, events: [rest({ type: 'whole', dots: 0 }, 0, { measureRest: true })] });
    }
    part.content[measure.id] = list;
  });
}

function readNote(node: XmlElement, pitchEl: XmlElement, used: Set<string>) {
  const ties = kids(node, 'tie');
  const acc = childText(node, 'accidental');
  return {
    id: keepId(node.attrs.id, 'n', used),
    pitch: {
      step: (childText(pitchEl, 'step') ?? 'C') as Step,
      alter: Math.round(childNum(pitchEl, 'alter') ?? 0),
      octave: childNum(pitchEl, 'octave') ?? 4,
    },
    tieStart: ties.some((t) => t.attrs.type === 'start') || undefined,
    tieStop: ties.some((t) => t.attrs.type === 'stop') || undefined,
    accidentalDisplay: acc && child(node, 'accidental')?.attrs.cautionary === 'yes' ? ('cautionary' as const) : undefined,
  };
}

function readDuration(node: XmlElement, ticks: number): Duration {
  const type = childText(node, 'type') as DurationType | undefined;
  const dots = kids(node, 'dot').length;
  const tm = child(node, 'time-modification');
  const tuplet = tm ? { actual: childNum(tm, 'actual-notes') ?? 3, normal: childNum(tm, 'normal-notes') ?? 2 } : undefined;
  if (type && DURATION_TYPES.has(type)) return { type, dots, tuplet };
  return exactDurationForTicks(ticks) ?? ticksToDurations(ticks)[0] ?? { type: 'quarter', dots: 0 };
}

/** Số quãng năm của nhạc cụ chuyển giọng: written key = concert key − instrumentFifths */
export function instrumentFifths(part: Part): number {
  const { transposeChromatic: c, transposeDiatonic: d } = part.instrument;
  if (c === 0 && d === 0) return 0;
  return fifthsOfInterval({ chromatic: c, diatonic: d });
}

// ====================================================================== EXPORT

export interface MusicXmlExportOptions {
  /** Ghi thuộc tính id cho note/measure (mặc định true) */
  writeIds?: boolean;
  software?: string;
}

const BAR_STYLE: Record<Barline, string | undefined> = { regular: undefined, double: 'light-light', final: 'light-heavy', dashed: 'dashed', none: 'none' };

export function exportMusicXml(score: ScoreDocument, opts: MusicXmlExportOptions = {}): string {
  const writeIds = opts.writeIds ?? true;
  const id = (v: string) => (writeIds ? v : undefined);

  const creators = (
    [['composer', score.meta.composer], ['lyricist', score.meta.lyricist], ['arranger', score.meta.arranger]] as const
  ).filter(([, v]) => v).map(([t, v]) => tel('creator', v, { type: t }));

  const root = el('score-partwise', { version: '4.0' }, [
    el('work', {}, [tel('work-title', score.meta.title)]),
    score.meta.subtitle ? tel('movement-title', score.meta.subtitle) : undefined,
    el('identification', {}, [
      ...creators,
      score.meta.copyright ? tel('rights', score.meta.copyright) : undefined,
      el('encoding', {}, [tel('software', opts.software ?? 'Holy Melody'), tel('encoding-date', new Date().toISOString().slice(0, 10))]),
    ]),
    el('defaults', {}, [el('lyric-font', { 'font-family': score.layout.lyricFont, 'font-size': score.layout.lyricFontSizePt })]),
    el('part-list', {}, score.parts.map((p) =>
      el('score-part', { id: p.id }, [
        tel('part-name', p.name),
        p.abbreviation ? tel('part-abbreviation', p.abbreviation) : undefined,
        el('score-instrument', { id: `${p.id}-I1` }, [tel('instrument-name', p.instrument.name)]),
        el('midi-instrument', { id: `${p.id}-I1` }, [tel('midi-channel', p.instrument.channel + 1), tel('midi-program', p.instrument.program + 1)]),
      ]),
    )),
    ...score.parts.map((p, pi) => exportPart(score, p, pi === 0, id)),
  ]);

  const header =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">';
  return serializeXml(root, header);
}

function exportPart(score: ScoreDocument, part: Part, isFirst: boolean, id: (v: string) => string | undefined): XmlElement {
  const instrFifths = instrumentFifths(part);
  const measures: XmlElement[] = score.measures.map((m, mi) => {
    const children: XmlNode[] = [];
    if (mi > 0 && (m.systemBreak || m.pageBreak)) {
      children.push(el('print', { 'new-system': m.systemBreak ? 'yes' : undefined, 'new-page': m.pageBreak ? 'yes' : undefined }));
    }
    if (m.repeatStart || m.volta) {
      children.push(el('barline', { location: 'left' }, [
        m.repeatStart ? tel('bar-style', 'heavy-light') : undefined,
        m.volta && (mi === 0 || !sameVolta(score.measures[mi - 1]?.volta, m.volta))
          ? el('ending', { number: m.volta.numbers.join(', '), type: 'start' }, [m.volta.numbers.join('. ') + '.'])
          : undefined,
        m.repeatStart ? el('repeat', { direction: 'forward' }) : undefined,
      ]));
    }
    // attributes
    const keyChange = score.keyMap.find((k) => k.measureIndex === mi);
    const timeChange = score.timeSigMap.find((t) => t.measureIndex === mi);
    if (mi === 0 || keyChange || timeChange) {
      const attrs: XmlNode[] = [];
      if (mi === 0) attrs.push(tel('divisions', TICKS_PER_QUARTER));
      if (mi === 0 || keyChange) {
        const k = keyAt(score, mi);
        attrs.push(el('key', {}, [tel('fifths', normalizeFifths(k.fifths - instrFifths)), tel('mode', k.mode)]));
      }
      if (mi === 0 || timeChange) {
        const t = timeSigAt(score, mi);
        attrs.push(el('time', {}, [tel('beats', t.beats), tel('beat-type', t.beatType)]));
      }
      if (mi === 0) {
        if (part.staves.length > 1) attrs.push(tel('staves', part.staves.length));
        part.staves.forEach((s, si) =>
          attrs.push(el('clef', { number: part.staves.length > 1 ? si + 1 : undefined }, [
            tel('sign', s.clef.sign),
            s.clef.sign !== 'percussion' ? tel('line', s.clef.line) : undefined,
            s.clef.octaveChange ? tel('clef-octave-change', s.clef.octaveChange) : undefined,
          ])),
        );
        const { transposeChromatic: c, transposeDiatonic: d } = part.instrument;
        if (c || d) attrs.push(el('transpose', {}, [tel('diatonic', d), tel('chromatic', c)]));
      }
      children.push(el('attributes', {}, attrs));
    }
    if (isFirst && m.rehearsalMark) {
      children.push(el('direction', { placement: 'above' }, [el('direction-type', {}, [tel('rehearsal', m.rehearsalMark)])]));
    }
    if (isFirst) {
      for (const t of score.tempoMap.filter((x) => x.measureIndex === mi && x.offset === 0)) {
        children.push(el('direction', { placement: 'above' }, [
          el('direction-type', {}, [
            t.text
              ? tel('words', t.text)
              : el('metronome', {}, [tel('beat-unit', 'quarter'), tel('per-minute', t.bpm)]),
          ]),
          el('sound', { tempo: t.bpm }),
        ]));
      }
    }
    for (const d of score.dynamics.filter((x) => x.partId === part.id && x.measureId === m.id)) {
      children.push(el('direction', { placement: 'below' }, [
        el('direction-type', {}, [el('dynamics', {}, [el(d.mark)])]),
        d.offset ? tel('offset', d.offset) : undefined,
      ]));
    }

    const voices = [...(part.content[m.id] ?? [])].sort((a, b) => a.number - b.number);
    const harmonies = score.chordSymbols.filter((c) => c.partId === part.id && c.measureId === m.id).sort((a, b) => a.offset - b.offset);
    const key = keyAt(score, mi);
    const accState = new Map<string, number>(); // `${staff}:${step}${octave}` → alter hiện hành
    let pos = 0;
    voices.forEach((v, vi) => {
      if (vi > 0 && pos > 0) {
        children.push(el('backup', {}, [tel('duration', pos)]));
        pos = 0;
      }
      const timings = eventTicksIn(score, mi, v.events);
      v.events.forEach((ev, ei) => {
        const { start, ticks } = timings[ei]!;
        if (vi === 0) {
          while (harmonies.length && harmonies[0]!.offset <= start) children.push(harmonyEl(harmonies.shift()!, start, id));
        }
        children.push(...eventEls(ev, ticks, v.number, part.staves.length > 1, key.fifths - instrFifths, accState, id));
        pos = start + ticks;
      });
      if (vi === 0) while (harmonies.length) children.push(harmonyEl(harmonies.shift()!, pos, id));
    });

    if (m.repeatEnd || m.volta || m.barlineRight !== 'regular') {
      const next = score.measures[mi + 1];
      const voltaEnds = m.volta && !sameVolta(next?.volta, m.volta);
      if (m.repeatEnd || voltaEnds || m.barlineRight !== 'regular') {
        children.push(el('barline', { location: 'right' }, [
          tel('bar-style', m.repeatEnd ? 'light-heavy' : BAR_STYLE[m.barlineRight] ?? 'regular'),
          voltaEnds ? el('ending', { number: m.volta!.numbers.join(', '), type: m.volta!.closed || m.repeatEnd ? 'stop' : 'discontinue' }) : undefined,
          m.repeatEnd ? el('repeat', { direction: 'backward', times: m.repeatTimes && m.repeatTimes !== 2 ? m.repeatTimes : undefined }) : undefined,
        ]));
      }
    }

    return el('measure', { number: m.number, id: isFirst ? id(m.id) : undefined, implicit: m.pickup ? 'yes' : undefined }, children);
  });
  return el('part', { id: part.id }, measures);
}

const sameVolta = (a: ScoreDocument['measures'][number]['volta'], b: ScoreDocument['measures'][number]['volta']) =>
  !!a && !!b && a.numbers.join() === b.numbers.join();

function normalizeFifths(f: number): number {
  if (f > 7) return f - 12;
  if (f < -7) return f + 12;
  return f;
}

function harmonyEl(c: ChordSymbol, at: number, id: (v: string) => string | undefined): XmlElement {
  return el('harmony', { id: id(c.id) }, [
    el('root', {}, [tel('root-step', c.root.step), c.root.alter ? tel('root-alter', c.root.alter) : undefined]),
    tel('kind', c.kind),
    c.bass ? el('bass', {}, [tel('bass-step', c.bass.step), c.bass.alter ? tel('bass-alter', c.bass.alter) : undefined]) : undefined,
    c.offset !== at ? tel('offset', c.offset - at) : undefined,
  ]);
}

function eventEls(
  ev: MusicEvent, ticks: number, voice: number, multiStaff: boolean, writtenKey: number,
  accState: Map<string, number>, id: (v: string) => string | undefined,
): XmlElement[] {
  const common = (): XmlNode[] => [
    tel('voice', voice),
    ...(ev.kind === 'rest' && ev.measureRest ? [] : [tel('type', ev.duration.type), ...Array.from({ length: ev.duration.dots }, () => el('dot'))]),
  ];

  const tm = ev.duration.tuplet
    ? el('time-modification', {}, [tel('actual-notes', ev.duration.tuplet.actual), tel('normal-notes', ev.duration.tuplet.normal)])
    : undefined;
  const staffEl = multiStaff ? tel('staff', ev.staff + 1) : undefined;

  if (ev.kind === 'rest') {
    return [el('note', { id: id(ev.id), 'print-object': ev.hidden ? 'no' : undefined }, [
      el('rest', { measure: ev.measureRest ? 'yes' : undefined }),
      tel('duration', ticks),
      ...common(),
      tm,
      staffEl,
    ])];
  }
  return ev.notes.map((n, i) => {
    const k = `${ev.staff}:${n.pitch.step}${n.pitch.octave}`;
    const current = accState.has(k) ? accState.get(k)! : keyAlterFor(n.pitch.step, writtenKey);
    const needAcc = n.accidentalDisplay === 'show' || n.accidentalDisplay === 'cautionary' || (n.accidentalDisplay !== 'hide' && current !== n.pitch.alter && !n.tieStop);
    accState.set(k, n.pitch.alter);
    const accName = ({ '-2': 'flat-flat', '-1': 'flat', '0': 'natural', '1': 'sharp', '2': 'double-sharp' } as Record<string, string>)[String(n.pitch.alter)];
    const notations: XmlNode[] = [];
    if (n.tieStop) notations.push(el('tied', { type: 'stop' }));
    if (n.tieStart) notations.push(el('tied', { type: 'start' }));
    if (i === 0) {
      if (ev.slurStop) notations.push(el('slur', { type: 'stop', number: 1 }));
      if (ev.slurStart) notations.push(el('slur', { type: 'start', number: 1 }));
      const arts = ev.articulations.filter((a) => a !== 'fermata');
      if (arts.length) notations.push(el('articulations', {}, arts.map((a) => el(a === 'marcato' ? 'strong-accent' : a))));
      if (ev.ornaments?.length) notations.push(el('ornaments', {}, ev.ornaments.map((o) => el(o === 'trill' ? 'trill-mark' : o))));
      if (ev.articulations.includes('fermata')) notations.push(el('fermata', { type: 'upright' }));
    }
    return el('note', { id: id(n.id) }, [
      ev.grace ? el('grace', { slash: ev.graceSlash ? 'yes' : undefined }) : undefined,
      i > 0 ? el('chord') : undefined,
      el('pitch', {}, [tel('step', n.pitch.step), n.pitch.alter ? tel('alter', n.pitch.alter) : undefined, tel('octave', n.pitch.octave)]),
      ev.grace ? undefined : tel('duration', ticks),
      n.tieStop ? el('tie', { type: 'stop' }) : undefined,
      n.tieStart ? el('tie', { type: 'start' }) : undefined,
      ...common(),
      needAcc && accName ? tel('accidental', accName, { cautionary: n.accidentalDisplay === 'cautionary' ? 'yes' : undefined }) : undefined,
      tm,
      staffEl,
      notations.length ? el('notations', {}, notations) : undefined,
      ...(i === 0
        ? (ev as ChordEvent).lyrics.map((l) =>
            el('lyric', { number: l.verse, id: id(l.id), 'relative-x': l.offsetX ? Math.round(l.offsetX * 10) : undefined }, [tel('syllabic', l.syllabic), tel('text', l.text), l.extend ? el('extend') : undefined]),
          )
        : []),
    ]);
  });
}
