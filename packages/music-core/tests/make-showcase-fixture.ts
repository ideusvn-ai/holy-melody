// Sinh fixture "notation-showcase.musicxml": liên 3, chùm nốt, nối, luyến, láy, nốt hoa mỹ, hợp âm ba, cường độ, dấu lặp.
import { writeFileSync } from 'node:fs';
import {
  addGraceNote, addTriad, CommandHistory, exportMusicXml, makeTuplet, ScoreIndex, setDynamic, toggleArticulation, toggleOrnament,
  toggleRepeat, toggleSlur, toggleTie, useDeterministicIds, setBarline,
} from '../src/index.js';
import { buildScore } from './helpers.js';

useDeterministicIds();
const s = buildScore([
  { name: 'Soprano', measures: ['G4:e:Ha A4:e:lê B4:e:lu C5:e:ia D5:q:Ha G4:q:lê', 'E5:q:lu D5:q:ia C5:q B4:q', 'A4:e B4:e C5:e A4:e D5:h', 'G4:q:Amen A4:q B4:q C5:q', 'C5:h G4:h'] },
  { name: 'Piano', clef: 'F', measures: ['G2:w', 'C3:h D3:h', 'E3:h D3:h', 'C3:q D3:q E3:q A2:q', 'D3:h G2:h'] },
], { keyFifths: 1, bpm: 88 });
s.meta.title = 'Trình diễn ký âm';
const h = new CommandHistory(s);
const ev = (part: number, m: number, i: number) => s.parts[part]!.content[s.measures[m]!.id]![0]!.events[i]!.id;
h.execute(toggleSlur([ev(0, 0, 0), ev(0, 0, 3)]));
h.execute(setDynamic(ev(0, 0, 0), 'mp'));
h.execute(toggleOrnament(ev(0, 0, 4), 'trill'));
h.execute(makeTuplet(ev(0, 1, 1), 3));
h.execute(toggleOrnament(ev(0, 1, 0), 'mordent'));
h.execute(toggleArticulation(ev(0, 1, 4), 'staccato'));
h.execute(toggleArticulation(ev(0, 1, 5), 'accent'));
h.execute(addGraceNote(ev(0, 2, 4)));
h.execute(toggleOrnament(ev(0, 2, 2), 'turn'));
h.execute(setDynamic(ev(0, 2, 0), 'f'));
h.execute(toggleArticulation(ev(0, 3, 0), 'tenuto'));
h.execute(toggleArticulation(ev(0, 4, 1), 'fermata'));
h.execute(addTriad(ev(1, 1, 0)));
h.execute(addTriad(ev(1, 1, 1)));
h.execute(addTriad(ev(1, 2, 0), 1));
const noteOf = (id: string) => (new ScoreIndex(s).event(id)!.event as { notes: { id: string }[] }).notes[0]!.id;
h.execute(toggleTie(noteOf(ev(0, 3, 3)))); // C5 nối qua vạch nhịp
h.execute(toggleRepeat(1, 'start'));
h.execute(toggleRepeat(2, 'end'));
h.execute(setBarline(4, 'final'));
writeFileSync(new URL('./fixtures/notation-showcase.musicxml', import.meta.url), exportMusicXml(s));
console.log('ok');
