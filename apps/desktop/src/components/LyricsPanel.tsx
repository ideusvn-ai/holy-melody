/**
 * Lời ca thông minh: dán cả đoạn lời → tự tách âm tiết và gán vào nốt; chỉnh font, cỡ chữ, vị trí,
 * khoảng cách phiên khúc và dịch từng âm tiết. Mọi thay đổi có Undo.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  distributeLyrics, lyricsToText, nudgeLyric, planLyrics, ScoreIndex, setLyric, setLyricStyle, versesOf,
} from '@holy-melody/music-core';
import { useActiveProject, useStore } from '../state/store';

const FONTS = ['Noto Serif', 'Times New Roman', 'Georgia', 'Be Vietnam Pro', 'Arial', 'Roboto', 'Tahoma', 'Segoe UI'];

export function LyricsPanel() {
  const project = useActiveProject();
  const st = useStore();
  useStore((s) => s.revision);
  const score = project?.score;
  const [partId, setPartId] = useState('');
  const [verse, setVerse] = useState(1);
  const [text, setText] = useState('');
  const [fromSelection, setFromSelection] = useState(false);
  const pid = partId || score?.parts[0]?.id || '';
  const verses = score ? versesOf(score, pid) : [];
  const maxVerse = Math.max(1, ...verses);

  // nạp lời hiện có khi đổi bè/phiên khúc
  useEffect(() => {
    if (score && pid) setText(lyricsToText(score, pid, verse));
  }, [project?.id, pid, verse]); // eslint-disable-line react-hooks/exhaustive-deps

  const selEvent = useMemo(() => {
    if (!score) return undefined;
    const idx = new ScoreIndex(score);
    const id = st.selection.noteIds[0];
    const loc = id ? idx.note(id) : st.selection.eventIds[0] ? idx.event(st.selection.eventIds[0]) : undefined;
    return loc?.event.kind === 'chord' ? loc : undefined;
  }, [score, st.selection, st.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = useMemo(() => {
    if (!score || !pid || !text.trim()) return null;
    try {
      return planLyrics(score, { partId: pid, verse, text, startEventId: fromSelection ? selEvent?.event.id : undefined }).report;
    } catch {
      return null;
    }
  }, [score, pid, verse, text, fromSelection, selEvent, st.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // kiểu chữ: giữ trạng thái cục bộ khi kéo thanh trượt, chỉ ghi (1 bước Undo) khi thả
  const L = score?.layout;
  const [size, setSize] = useState(L?.lyricFontSizePt ?? 10);
  const [offset, setOffset] = useState(L?.lyricOffsetSp ?? 3);
  const [spacing, setSpacing] = useState(L?.lyricVerseSpacingSp ?? 2.2);
  useEffect(() => {
    setSize(L?.lyricFontSizePt ?? 10);
    setOffset(L?.lyricOffsetSp ?? 3);
    setSpacing(L?.lyricVerseSpacingSp ?? 2.2);
  }, [L?.lyricFontSizePt, L?.lyricOffsetSp, L?.lyricVerseSpacingSp]);

  if (!project || !score || !L) return null;
  const sel = 'w-full h-8 rounded-md border border-line bg-surface px-2';
  const curLyric = selEvent?.event.kind === 'chord' ? selEvent.event.lyrics.find((l) => l.verse === verse) : undefined;

  const apply = () => {
    if (fromSelection && !selEvent) {
      st.notify('Hãy chọn nốt bắt đầu trên bản nhạc.');
      return;
    }
    st.exec(distributeLyrics({ partId: pid, verse, text, startEventId: fromSelection ? selEvent?.event.id : undefined }));
    if (plan) {
      const extra = plan.leftoverSyllables ? ` · thừa ${plan.leftoverSyllables} âm tiết (chưa có nốt)` : '';
      st.notify(`Đã gán ${plan.syllables - plan.leftoverSyllables} âm tiết vào lời ${verse}${extra}.`);
    }
  };

  const slider = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, commit: (v: number) => void, unit: string) => (
    <label className="block space-y-1">
      <span className="flex justify-between text-[11px] text-muted"><span>{label}</span><span className="tabular-nums">{value}{unit}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} className="w-full accent-[var(--accent)]"
        onChange={(e) => set(Number(e.target.value))}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))} />
    </label>
  );

  return (
    <section className="p-3 space-y-4" aria-label="Lời ca">
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted">Bè</span>
            <select className={sel} value={pid} onChange={(e) => setPartId(e.target.value)}>
              {score.parts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted">Phiên khúc</span>
            <select className={sel} value={verse} onChange={(e) => setVerse(Number(e.target.value))}>
              {Array.from({ length: maxVerse + 1 }, (_, i) => i + 1).map((v) => (
                <option key={v} value={v}>Lời {v}{verses.includes(v) ? '' : ' (mới)'}</option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          className="w-full min-h-28 rounded-md border border-line bg-surface p-2 leading-relaxed text-[13px]"
          lang="vi" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={'Dán hoặc gõ lời, ví dụ:\nXin Chúa thương xót chúng con.\nHal-le-lu-jah A-men _'}
          aria-label={`Lời ${verse}`}
        />
        <p className="text-[10.5px] text-muted leading-snug">Mỗi chữ một nốt · "-" tách âm tiết trong một từ (A-men) · "_" ngân chữ trước sang nốt sau · nốt nối và nốt trong dấu luyến được bỏ qua tự động.</p>
        {plan && (
          <div className={`text-[11px] rounded-md px-2 py-1.5 ${plan.leftoverSyllables ? 'bg-warn/10 text-warn' : 'bg-play/10 text-play'}`}>
            {plan.syllables} âm tiết → {plan.notesUsed} nốt
            {plan.leftoverSyllables > 0 && ` · thừa ${plan.leftoverSyllables} âm tiết`}
            {plan.leftoverSyllables === 0 && plan.notesWithoutLyrics > 0 && ` · còn ${plan.notesWithoutLyrics} nốt chưa có lời`}
          </div>
        )}
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={fromSelection} onChange={(e) => setFromSelection(e.target.checked)} />
          Bắt đầu từ nốt đang chọn
        </label>
        <button className="w-full h-9 rounded-md bg-accent text-accent-fg font-semibold hover:brightness-110 disabled:opacity-40" disabled={!text.trim()} onClick={apply}>
          Gán lời vào nốt
        </button>
      </div>

      <div className="space-y-3 border-t border-line pt-3">
        <h3 className="text-[11px] uppercase tracking-wide text-muted">Kiểu chữ & vị trí</h3>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted">Font</span>
          <select className={sel} value={L.lyricFont} style={{ fontFamily: L.lyricFont }} onChange={(e) => st.exec(setLyricStyle({ lyricFont: e.target.value }))}>
            {[...new Set([L.lyricFont, ...FONTS])].map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
        </label>
        {slider('Cỡ chữ', size, 6, 18, 0.5, setSize, (v) => st.exec(setLyricStyle({ lyricFontSizePt: v })), ' pt')}
        {slider('Cách khuông nhạc', offset, 1.5, 8, 0.25, setOffset, (v) => st.exec(setLyricStyle({ lyricOffsetSp: v })), ' khoảng')}
        {slider('Cách giữa các lời', spacing, 1.5, 5, 0.1, setSpacing, (v) => st.exec(setLyricStyle({ lyricVerseSpacingSp: v })), ' khoảng')}
        <div className="flex items-center gap-4 text-[12px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={L.showVerseNumbers !== false} onChange={(e) => st.exec(setLyricStyle({ showVerseNumbers: e.target.checked }))} />
            Số phiên khúc
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={(L.lyricItalicVerses ?? []).includes(verse)}
              onChange={(e) => st.exec(setLyricStyle({ lyricItalicVerses: e.target.checked ? [...new Set([...(L.lyricItalicVerses ?? []), verse])] : (L.lyricItalicVerses ?? []).filter((v) => v !== verse) }))} />
            Lời {verse} in nghiêng
          </label>
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <h3 className="text-[11px] uppercase tracking-wide text-muted">Âm tiết đang chọn (lời {verse})</h3>
        {selEvent ? (
          <>
            <input
              key={`${selEvent.event.id}-${verse}`}
              className="w-full h-8 rounded-md border border-line bg-surface px-2"
              defaultValue={curLyric?.text ?? ''}
              placeholder="Nhập âm tiết…"
              lang="vi"
              aria-label="Âm tiết"
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') st.exec(setLyric(selEvent.event.id, verse, (e.target as HTMLInputElement).value));
              }}
              onBlur={(e) => { if (e.target.value !== (curLyric?.text ?? '')) st.exec(setLyric(selEvent.event.id, verse, e.target.value)); }}
            />
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted mr-auto">Dịch ngang{curLyric?.offsetX ? ` (${curLyric.offsetX > 0 ? '+' : ''}${curLyric.offsetX})` : ''}</span>
              <button className="h-7 w-8 rounded border border-line hover:bg-surface-2 disabled:opacity-40" disabled={!curLyric} onClick={() => st.exec(nudgeLyric(selEvent.event.id, verse, -0.25))} aria-label="Dịch trái">←</button>
              <button className="h-7 px-2 rounded border border-line hover:bg-surface-2 text-[11px] disabled:opacity-40" disabled={!curLyric?.offsetX} onClick={() => st.exec(nudgeLyric(selEvent.event.id, verse, 0))}>Đặt lại</button>
              <button className="h-7 w-8 rounded border border-line hover:bg-surface-2 disabled:opacity-40" disabled={!curLyric} onClick={() => st.exec(nudgeLyric(selEvent.event.id, verse, 0.25))} aria-label="Dịch phải">→</button>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted">Chọn một nốt trên bản nhạc để sửa hoặc dịch âm tiết.</p>
        )}
      </div>
    </section>
  );
}
