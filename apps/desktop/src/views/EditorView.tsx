import { useEffect, useMemo, useState } from 'react';
import {
  addChordTone, durationTicks, placeNote, addGraceNote, addInterval, addTriad, buildTimeline, chord, deleteEvent, deleteMeasure, insertMeasure, keyAlterFor, keyAt,
  makeTuplet, pitchToMidi, replaceEvent, spellMidi, ScoreIndex, setBarline, setDuration, setDynamic, setKeySignature, setLyric, setPitch,
  setTimeSignature, timeSigAt, toggleArticulation, toggleOrnament, toggleRepeat, toggleSlur, toggleTie, transpose, transposePitch,
  type DurationType, type NoteLocation, type Step,
} from '@holy-melody/music-core';
import { HarmonyPanel } from '../components/HarmonyPanel';
import { useMidiInput } from '../lib/midiInput';
import { LyricsPanel } from '../components/LyricsPanel';
import { AdvisorPanel } from '../components/AdvisorPanel';
import { ScoreView } from '../components/ScoreView';
import { Transport } from '../components/Transport';
import { useActiveProject, useStore } from '../state/store';
import { EditGate, ReviewPanel } from '../components/ReviewPanel';
import { ConvertDialog } from '../components/ConvertDialog';
import { MidiDevice } from '../components/MidiDevice';
import { usePlayback } from '../state/playback';

const DURATIONS: { type: DurationType; key: string; label: string; glyph: string }[] = [
  { type: 'whole', key: '7', label: 'Nốt tròn', glyph: '𝅝' },
  { type: 'half', key: '6', label: 'Nốt trắng', glyph: '𝅗𝅥' },
  { type: 'quarter', key: '5', label: 'Nốt đen', glyph: '𝅘𝅥' },
  { type: 'eighth', key: '4', label: 'Nốt móc đơn', glyph: '𝅘𝅥𝅮' },
  { type: '16th', key: '3', label: 'Nốt móc kép', glyph: '𝅘𝅥𝅯' },
  { type: '32nd', key: '2', label: 'Móc ba', glyph: '𝅘𝅥𝅰' },
  { type: '64th', key: '1', label: 'Móc bốn', glyph: '𝅘𝅥𝅱' },
];

/** Event đang chọn (event đầu tiên của vùng chọn) */
function useSelectedEvent() {
  const project = useActiveProject();
  const sel = useStore((s) => s.selection);
  useStore((s) => s.revision);
  if (!project) return undefined;
  const idx = new ScoreIndex(project.score);
  if (sel.noteIds[0]) return idx.note(sel.noteIds[0]);
  if (sel.eventIds[0]) return idx.event(sel.eventIds[0]);
  return undefined;
}

export function EditorLeft() {
  const project = useActiveProject();
  const loc = useSelectedEvent();
  const exec = useStore((s) => s.exec);
  const sel = useStore((s) => s.selection);
  const noteInput = useStore((s) => s.noteInput);
  const inputDuration = useStore((s) => s.inputDuration);
  const setNoteInput = useStore((s) => s.setNoteInput);
  const setInputDuration = useStore((s) => s.setInputDuration);
  if (!project || project.score.sheet?.mode === 'overlay') return null;
  const ev = loc?.event;
  const chordEv = ev?.kind === 'chord' ? ev : undefined;
  const noteLoc = loc && 'note' in loc ? (loc as NoteLocation) : undefined;
  const mIndex = sel.measureRange?.[0] ?? loc?.measureIndex;
  const measure = mIndex !== undefined ? project.score.measures[mIndex] : undefined;
  const key = keyAt(project.score, mIndex ?? 0);
  const ts = timeSigAt(project.score, mIndex ?? 0);

  const group = (title: string, children: React.ReactNode) => (
    <section className="space-y-1.5">
      <h3 className="text-[11px] uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
  const tool = 'h-9 rounded-md border border-line bg-surface hover:bg-surface-2 active:scale-95 transition disabled:opacity-35 grid place-items-center';
  const on = (b?: boolean) => (b ? 'ring-2 ring-accent bg-accent-soft' : '');
  const btn = (label: React.ReactNode, title: string, onClick: () => void, disabled: boolean, active?: boolean, extra = '') => (
    <button className={`${tool} ${on(active)} ${extra}`} title={title} aria-label={title} disabled={disabled} onClick={onClick}>{label}</button>
  );

  return (
    <div className="p-3 space-y-4">
      {group('Notes', (
        <>
          <button className={`w-full h-9 rounded-md border text-[12.5px] font-medium ${noteInput ? 'bg-accent text-accent-fg border-accent' : 'border-line hover:bg-surface-2'}`}
            onClick={() => setNoteInput(!noteInput)} title="Nhập nốt (N): bấm lên khuông để đặt nốt, giữ Shift để thêm vào hợp âm">
            {noteInput ? '✎ Đang nhập nốt (N)' : '✎ Nhập nốt (N)'}
          </button>
          {noteInput && <p className="text-[10.5px] text-muted leading-snug">Chọn trường độ rồi bấm lên khuông đúng cao độ: nốt ghi đè dấu lặng. Shift+bấm: thêm vào hợp âm. Esc: thoát.</p>}
          <div className="grid grid-cols-4 gap-1">
            {DURATIONS.map((d) => btn(<span className="text-lg font-[var(--font-music)]">{d.glyph}</span>, `${d.label} (${d.key})`, () => {
              setInputDuration({ type: d.type, dots: 0 });
              if (ev && !noteInput) exec(setDuration(ev.id, { ...ev.duration, type: d.type }));
            }, false, noteInput ? inputDuration.type === d.type : ev?.duration.type === d.type))}
            {btn(<span className="text-lg">𝅭</span>, 'Chấm dôi (.)', () => {
              if (noteInput) setInputDuration({ ...inputDuration, dots: (inputDuration.dots + 1) % 2 });
              else if (ev) exec(setDuration(ev.id, { ...ev.duration, dots: (ev.duration.dots + 1) % 3 }));
            }, !noteInput && !ev, noteInput ? !!inputDuration.dots : !!ev?.duration.dots)}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {([['♭', -1, 'Giáng (-)'], ['♮', 0, 'Bình (=)'], ['♯', 1, 'Thăng (+)']] as const).map(([g, a, t]) => btn(<span className="text-base">{g}</span>, t, () => noteLoc && exec(setPitch(noteLoc.note.id, { ...noteLoc.note.pitch, alter: a })), !noteLoc, noteLoc?.note.pitch.alter === a))}
            {btn(<span className="text-sm">𝄽</span>, 'Đổi thành dấu lặng (0 / Delete)', () => ev && exec(deleteEvent(ev.id)), !ev || ev.kind === 'rest')}
          </div>
          <div className="grid grid-cols-4 gap-1 text-[11px]">
            {btn('Nối', 'Dấu nối – tie (T)', () => noteLoc && exec(toggleTie(noteLoc.note.id)), !noteLoc, !!noteLoc?.note.tieStart)}
            {btn('Liên 3', 'Liên 3 – triplet (Ctrl+3)', () => ev && exec(makeTuplet(ev.id, 3)), !ev || !!ev.duration.tuplet)}
            {btn('Liên 5', 'Liên 5', () => ev && exec(makeTuplet(ev.id, 5)), !ev || !!ev.duration.tuplet)}
            {btn('Liên 6', 'Liên 6', () => ev && exec(makeTuplet(ev.id, 6)), !ev || !!ev.duration.tuplet)}
          </div>
        </>
      ))}
      {group('Hợp âm trên khuông', (
        <>
          <div className="grid grid-cols-3 gap-1 text-[11px]">
            {btn('Hợp âm ba', 'Dựng hợp âm ba theo giọng (Shift+T)', () => chordEv && exec(addTriad(chordEv.id)), !chordEv)}
            {btn('Đảo 1', 'Hợp âm ba thể đảo 1', () => chordEv && exec(addTriad(chordEv.id, 1)), !chordEv)}
            {btn('Đảo 2', 'Hợp âm ba thể đảo 2', () => chordEv && exec(addTriad(chordEv.id, 2)), !chordEv)}
          </div>
          <div className="grid grid-cols-7 gap-1 text-[11px]">
            {[2, 3, 4, 5, 6, 7, 8].map((n) => btn(String(n), `Thêm quãng ${n} phía trên (Alt+${n})`, () => chordEv && exec(addInterval(chordEv.id, n)), !chordEv))}
          </div>
        </>
      ))}
      {group('Luyến láy', (
        <div className="grid grid-cols-3 gap-1 text-[11px]">
          {btn('Luyến', 'Dấu luyến – slur (S): chọn nốt đầu, Shift+click nốt cuối', () => sel.eventIds.length && exec(toggleSlur(sel.eventIds)), !chordEv, !!chordEv?.slurStart)}
          {btn(<i className="font-serif font-bold">tr</i>, 'Láy rền – trill', () => chordEv && exec(toggleOrnament(chordEv.id, 'trill')), !chordEv, chordEv?.ornaments?.includes('trill'))}
          {btn('Mordent', 'Láy mordent', () => chordEv && exec(toggleOrnament(chordEv.id, 'mordent')), !chordEv, chordEv?.ornaments?.includes('mordent'))}
          {btn('Mord. ngược', 'Láy mordent ngược', () => chordEv && exec(toggleOrnament(chordEv.id, 'inverted-mordent')), !chordEv, chordEv?.ornaments?.includes('inverted-mordent'))}
          {btn('Turn', 'Láy vòng – turn', () => chordEv && exec(toggleOrnament(chordEv.id, 'turn')), !chordEv, chordEv?.ornaments?.includes('turn'))}
          {btn('Hoa mỹ', 'Nốt hoa mỹ (acciaccatura) trước nốt chọn', () => chordEv && exec(addGraceNote(chordEv.id)), !chordEv || !!chordEv.grace)}
        </div>
      ))}
      {group('Expression', (
        <>
          <div className="grid grid-cols-5 gap-1">
            {([['staccato', '•', 'Staccato'], ['tenuto', '–', 'Tenuto'], ['accent', '>', 'Accent'], ['marcato', '^', 'Marcato'], ['fermata', '𝄐', 'Fermata (dấu ngân)']] as const).map(([a, g, t]) =>
              btn(<span className="text-base font-bold">{g}</span>, t, () => chordEv && exec(toggleArticulation(chordEv.id, a)), !chordEv, chordEv?.articulations.includes(a)))}
          </div>
          <div className="grid grid-cols-6 gap-1">
            {(['pp', 'p', 'mp', 'mf', 'f', 'ff'] as const).map((d) => btn(<i className="font-serif font-bold">{d}</i>, `Cường độ ${d}`, () => ev && exec(setDynamic(ev.id, d)), !ev))}
          </div>
        </>
      ))}
      {group('Structure', (
        <>
          <div className="grid grid-cols-2 gap-1 text-[11px]">
            {btn('Chèn ô nhịp', 'Chèn ô nhịp trước ô chọn', () => exec(insertMeasure(mIndex ?? 0)), mIndex === undefined)}
            {btn('Xóa ô nhịp', 'Xóa ô nhịp đang chọn', () => mIndex !== undefined && exec(deleteMeasure(mIndex)), mIndex === undefined)}
            {btn('𝄆 Lặp mở', 'Dấu lặp mở', () => mIndex !== undefined && exec(toggleRepeat(mIndex, 'start')), mIndex === undefined, measure?.repeatStart)}
            {btn('Lặp đóng 𝄇', 'Dấu lặp đóng', () => mIndex !== undefined && exec(toggleRepeat(mIndex, 'end')), mIndex === undefined, measure?.repeatEnd)}
            {btn('Vạch kép', 'Vạch nhịp kép', () => mIndex !== undefined && exec(setBarline(mIndex, measure?.barlineRight === 'double' ? 'regular' : 'double')), mIndex === undefined, measure?.barlineRight === 'double')}
            {btn('Vạch kết', 'Vạch kết bài', () => mIndex !== undefined && exec(setBarline(mIndex, measure?.barlineRight === 'final' ? 'regular' : 'final')), mIndex === undefined, measure?.barlineRight === 'final')}
            {btn('Thêm ô cuối', 'Thêm ô nhịp ở cuối bài', () => exec(insertMeasure(project.score.measures.length)), false)}
          </div>
          <div className="grid grid-cols-2 gap-1">
            <select className="h-8 rounded-md border border-line bg-surface px-1.5 text-[12px] disabled:opacity-40" disabled={mIndex === undefined} value={key.fifths}
              onChange={(e) => mIndex !== undefined && exec(setKeySignature(mIndex, Number(e.target.value), key.mode))} aria-label="Hóa biểu" title="Hóa biểu từ ô chọn">
              {Array.from({ length: 15 }, (_, i) => i - 7).map((f) => <option key={f} value={f}>{KEYS[f + 7]} {key.mode === 'minor' ? 'thứ' : 'trưởng'}</option>)}
            </select>
            <select className="h-8 rounded-md border border-line bg-surface px-1.5 text-[12px] disabled:opacity-40" disabled={mIndex === undefined} value={`${ts.beats}/${ts.beatType}`}
              onChange={(e) => { const [b, t] = e.target.value.split('/').map(Number); if (mIndex !== undefined) exec(setTimeSignature(mIndex, b!, t!)); }} aria-label="Số chỉ nhịp" title="Số chỉ nhịp từ ô chọn">
              {['2/4', '3/4', '4/4', '2/2', '3/8', '6/8', '9/8', '12/8', '5/4'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </div>
        </>
      ))}
      {group('Transpose', (
        <div className="grid grid-cols-2 gap-1 text-[11px]">
          {btn('Lên ½ cung', 'Chuyển toàn bài lên nửa cung', () => exec(transpose({ by: 'semitones', semitones: 1 })), false)}
          {btn('Xuống ½ cung', 'Chuyển toàn bài xuống nửa cung', () => exec(transpose({ by: 'semitones', semitones: -1 })), false)}
          {btn('Lên 1 cung', 'Chuyển toàn bài lên một cung', () => exec(transpose({ by: 'semitones', semitones: 2 })), false)}
          {btn('Xuống 1 cung', 'Chuyển toàn bài xuống một cung', () => exec(transpose({ by: 'semitones', semitones: -2 })), false)}
        </div>
      ))}
      <p className="text-[10px] text-muted leading-snug">
        Phím tắt: N nhập nốt (bấm lên khuông) · A–G cao độ (tự sang nốt kế) · Shift+A–G thêm vào hợp âm · ↑/↓ bậc theo giọng · Shift+↑/↓ nửa cung · 1–7 trường độ · . chấm dôi · T nối · S luyến · Ctrl+3 liên 3 · Alt+2…8 thêm quãng · Delete dấu lặng · ⌘/Ctrl+Z hoàn tác.
      </p>
      <MidiDevice />
    </div>
  );
}

const KEYS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];

export function EditorRight() {
  const project = useActiveProject();
  const fromSheet = project?.score.sheet?.mode === 'edit';
  const [tab, setTab] = useState<'review' | 'advisor' | 'harmony' | 'lyrics'>(fromSheet ? 'review' : 'advisor');
  if (project?.score.sheet?.mode === 'overlay') return null;
  const tabs = [...(fromSheet ? [['review', 'Đối chiếu']] : []), ['advisor', 'Trợ lý'], ['harmony', 'Hợp âm'], ['lyrics', 'Lời ca']] as [typeof tab, string][];
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex border-b border-line text-[12px]" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`flex-1 h-9 relative ${tab === id ? 'font-semibold text-fg' : 'text-muted hover:text-fg'}`}>
            {label}
            {tab === id && <span className="absolute left-3 right-3 bottom-0 h-0.5 bg-accent rounded-full" />}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex flex-col">
        {tab === 'review' && fromSheet ? <ReviewPanel /> : tab === 'advisor' || tab === 'review' ? <AdvisorPanel /> : tab === 'harmony' ? <HarmonyPanel /> : <LyricsPanel />}
      </div>
    </div>
  );
}

export function EditorCenter() {
  const suggestions = useStore((s) => s.advisor.suggestions);
  const flagged = useMemo(() => suggestions.flatMap((x) => (x.severity !== 'info' ? x.noteIds : [])), [suggestions]);
  const setTab = useStore((s) => s.setTab);
  const project = useActiveProject();
  const [convert, setConvert] = useState(false);
  useEditorShortcuts();
  useMidiStepInput();
  if (project?.score.sheet?.mode === 'overlay') {
    return (
      <>
        <EditGate onConvert={() => setConvert(true)} />
        {convert && <ConvertDialog onClose={() => setConvert(false)} />}
      </>
    );
  }
  const ready = project ? singerReadiness(project.score) : { ok: false, reason: '' };
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 h-10 px-3 border-b border-line bg-surface text-[12px]">
        <span className="text-muted truncate">{project?.score.meta.title}</span>
        <div className="flex-1" />
        <span className="text-muted hidden md:inline">{ready.ok ? 'Đủ nốt và lời để AI hát' : ready.reason}</span>
        <button className="h-7 px-3 rounded-md bg-accent text-accent-fg font-semibold disabled:opacity-40" disabled={!ready.ok}
          title={ready.ok ? 'Chuyển bản đang soạn sang AI Singer' : ready.reason} onClick={() => setTab('singer')}>
          ♪ AI Singer
        </button>
      </div>
      <ScoreView editable flaggedNoteIds={flagged} />
      <Transport compact onOpenFull={() => setTab('player')} />
    </div>
  );
}

/** Bản nhạc có đủ nốt và lời để AI hát chưa (bè có lời nhiều nhất phải có lời ở ≥ 70% số nốt, tối thiểu 4 nốt) */
export function singerReadiness(score: import('@holy-melody/music-core').ScoreDocument): { ok: boolean; reason: string } {
  let best = { notes: 0, sung: 0 };
  for (const p of score.parts) {
    let notes = 0;
    let sung = 0;
    for (const m of score.measures) {
      for (const v of p.content[m.id] ?? []) {
        for (const e of v.events) {
          if (e.kind !== 'chord' || e.grace) continue;
          if (e.notes.some((n) => n.tieStop)) continue; // nốt nối tiếp không cần lời
          notes++;
          if (e.lyrics?.some((l) => l.text.trim())) sung++;
        }
      }
    }
    if (sung > best.sung || (sung === best.sung && notes > best.notes)) best = { notes, sung };
  }
  if (best.notes < 4) return { ok: false, reason: 'Cần ít nhất 4 nốt để AI hát' };
  const ratio = best.sung / best.notes;
  if (ratio < 0.7) return { ok: false, reason: `Mới có lời cho ${best.sung}/${best.notes} nốt: thêm lời ở bảng Lời ca` };
  return { ok: true, reason: '' };
}

/** Nhập nốt step-time từ bàn phím MIDI: ghi vào event đang chọn rồi chuyển sang event kế tiếp */
function useMidiStepInput() {
  const project = useActiveProject();
  useEffect(() => useMidiInput.getState().onChord((pitches) => {
    const st = useStore.getState();
    if (st.tab !== 'editor' || !project || !pitches.length) return;
    const idx = new ScoreIndex(project.score);
    const loc = st.selection.noteIds[0] ? idx.note(st.selection.noteIds[0]) : st.selection.eventIds[0] ? idx.event(st.selection.eventIds[0]) : undefined;
    if (!loc) return;
    const fifths = keyAt(project.score, loc.measureIndex).fifths;
    const next = chord(pitches.map((p) => spellMidi(p, fifths)), loc.event.duration, { id: loc.event.id, staff: loc.event.staff, ...(loc.event.kind === 'chord' ? { lyrics: loc.event.lyrics } : {}) });
    st.exec(replaceEvent(loc.event.id, next));
    const order = buildOrder(project.score, loc.part.id, loc.voice.number);
    const i = order.findIndex((x) => x.eventId === loc.event.id);
    const nx = order[i + 1];
    if (nx) st.select({ eventIds: [nx.eventId], noteIds: nx.noteId ? [nx.noteId] : [], measureRange: undefined });
    else st.select({ eventIds: [next.id], noteIds: [next.notes[0]!.id] });
  }), [project]);
}

function useEditorShortcuts() {
  const project = useActiveProject();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.tab !== 'editor' || !project || project.score.sheet?.mode === 'overlay') return;
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      const idx = new ScoreIndex(project.score);
      const noteLoc = st.selection.noteIds[0] ? idx.note(st.selection.noteIds[0]) : undefined;
      const evLoc = noteLoc ?? (st.selection.eventIds[0] ? idx.event(st.selection.eventIds[0]) : undefined);
      const k = e.key;

      if (/^[a-gA-G]$/.test(k) && !e.metaKey && !e.ctrlKey && evLoc) {
        e.preventDefault();
        const step = k.toUpperCase() as Step;
        const order = buildOrder(project.score, evLoc.part.id, evLoc.voice.number);
        const at = order.findIndex((x) => x.eventId === evLoc.event.id);
        // cao độ tham chiếu: nốt đang chọn, hoặc nốt gần nhất phía trước (để chọn quãng tám hợp lý)
        const sidx = new ScoreIndex(project.score);
        const prevNoteId = noteLoc?.note.id ?? order.slice(0, Math.max(0, at)).reverse().find((x) => x.noteId)?.noteId;
        const prev = (prevNoteId && sidx.note(prevNoteId)?.note.pitch) || { step: 'C' as Step, alter: 0, octave: evLoc.event.staff > 0 || evLoc.part.staves[evLoc.event.staff]?.clef.sign === 'F' ? 3 : 4 };
        const fifths = keyAt(project.score, evLoc.measureIndex).fifths;
        const cands = [prev.octave - 1, prev.octave, prev.octave + 1].map((o) => ({ step, alter: keyAlterFor(step, fifths), octave: o }));
        const cur = prev.octave * 7 + 'CDEFGAB'.indexOf(prev.step);
        const p = cands.sort((a, b) => Math.abs(a.octave * 7 + 'CDEFGAB'.indexOf(a.step) - cur) - Math.abs(b.octave * 7 + 'CDEFGAB'.indexOf(b.step) - cur))[0]!;
        if (e.shiftKey && evLoc.event.kind === 'chord') {
          st.exec(addChordTone(evLoc.event.id, p));
        } else if (noteLoc) {
          st.exec(setPitch(noteLoc.note.id, p));
        } else {
          // dấu lặng → nốt (theo trường độ đang chọn khi nhập nốt), rồi tự sang vị trí kế tiếp để gõ tiếp
          const v = evLoc.voice.events;
          let tick = 0;
          for (const x of v) {
            if (x.id === evLoc.event.id) break;
            if (!(x.kind === 'chord' && x.grace)) tick += durationTicks(x.duration);
          }
          const cmd = placeNote({ partId: evLoc.part.id, measureIndex: evLoc.measureIndex, voice: evLoc.voice.number, staff: evLoc.event.staff, tick, pitch: p, duration: st.noteInput ? st.inputDuration : evLoc.event.duration });
          st.exec(cmd);
          const ord2 = buildOrder(project.score, evLoc.part.id, evLoc.voice.number);
          const k2 = ord2.findIndex((x) => x.eventId === cmd.result.eventId);
          const nx = ord2[k2 + 1];
          if (nx) st.select({ eventIds: [nx.eventId], noteIds: nx.noteId ? [nx.noteId] : [], measureRange: undefined });
          else if (cmd.result.noteId) st.select({ noteIds: [cmd.result.noteId], eventIds: [cmd.result.eventId!] });
        }
        usePlayback.getState().engine.previewNote(pitchToMidi(p));
        return;
      }
      if ((k === 'ArrowUp' || k === 'ArrowDown') && noteLoc && !e.metaKey) {
        e.preventDefault();
        const dir = k === 'ArrowUp' ? 1 : -1;
        const iv = e.shiftKey ? { diatonic: 0, chromatic: dir } : null;
        const p = iv
          ? { ...noteLoc.note.pitch, alter: noteLoc.note.pitch.alter + dir }
          : (() => {
              // lên/xuống một bậc theo hóa biểu của giọng (Fa trưởng: A → B♭)
              const nat = transposePitch({ ...noteLoc.note.pitch, alter: 0 }, { diatonic: dir, chromatic: diatonicSemis(noteLoc.note.pitch.step, dir) });
              return { ...nat, alter: keyAlterFor(nat.step, keyAt(project.score, noteLoc.measureIndex).fifths) };
            })();
        if (Math.abs(p.alter) <= 2) st.exec(setPitch(noteLoc.note.id, p));
        return;
      }
      if (k.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && evLoc) {
        e.preventDefault();
        if (e.shiftKey && evLoc.event.kind === 'chord') st.exec(addTriad(evLoc.event.id));
        else if (noteLoc) st.exec(toggleTie(noteLoc.note.id));
        return;
      }
      if (k.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey && evLoc) {
        e.preventDefault();
        st.exec(toggleSlur(st.selection.eventIds.length ? st.selection.eventIds : [evLoc.event.id]));
        return;
      }
      if (e.ctrlKey && /^[3567]$/.test(k) && evLoc) {
        e.preventDefault();
        st.exec(makeTuplet(evLoc.event.id, Number(k)));
        return;
      }
      if (e.altKey && /^Digit[2-8]$/.test(e.code) && evLoc?.event.kind === 'chord') {
        e.preventDefault();
        st.exec(addInterval(evLoc.event.id, Number(e.code.slice(5))));
        return;
      }
      if (k.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        st.setNoteInput(!st.noteInput);
        return;
      }
      if (k === 'Escape' && st.noteInput) {
        st.setNoteInput(false);
        return;
      }
      const dur = DURATIONS.find((d) => d.key === k);
      if (dur && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        st.setInputDuration({ type: dur.type, dots: 0 });
        if (evLoc) st.exec(setDuration(evLoc.event.id, { ...evLoc.event.duration, type: dur.type, tuplet: undefined }));
        return;
      }
      if (k === '.' && evLoc) {
        st.exec(setDuration(evLoc.event.id, { ...evLoc.event.duration, dots: (evLoc.event.duration.dots + 1) % 3 }));
        return;
      }
      if ((k === 'Delete' || k === 'Backspace' || k === '0') && evLoc) {
        e.preventDefault();
        st.exec(deleteEvent(evLoc.event.id));
        return;
      }
      if ((k === 'ArrowRight' || k === 'ArrowLeft') && !e.altKey) {
        // di chuyển chọn sang event kế tiếp/trước trong cùng voice
        if (!evLoc) return;
        e.preventDefault();
        const order = buildOrder(project.score, evLoc.part.id, evLoc.voice.number);
        const i = order.findIndex((x) => x.eventId === evLoc.event.id);
        const nx = order[i + (k === 'ArrowRight' ? 1 : -1)];
        if (nx) st.select({ eventIds: [nx.eventId], noteIds: nx.noteId ? [nx.noteId] : [], measureRange: undefined });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project]);
}

function diatonicSemis(step: Step, dir: number): number {
  const s = 'CDEFGAB'.indexOf(step);
  const semis = [2, 2, 1, 2, 2, 2, 1]; // C→D, D→E, E→F …
  return dir > 0 ? semis[s]! : -semis[(s + 6) % 7]!;
}

function buildOrder(score: Parameters<typeof buildTimeline>[0], partId: string, voiceNumber: number) {
  const part = score.parts.find((p) => p.id === partId)!;
  const out: { eventId: string; noteId?: string }[] = [];
  for (const m of score.measures) {
    const v = (part.content[m.id] ?? []).find((x) => x.number === voiceNumber);
    for (const e of v?.events ?? []) out.push({ eventId: e.id, noteId: e.kind === 'chord' ? e.notes[0]?.id : undefined });
  }
  return out;
}
