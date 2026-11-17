/**
 * AI Singer Studio — Phase 1: giao diện + phân tích bản nhạc cục bộ (thật).
 * Tạo giọng hát cần đăng nhập, credit và một provider SVS có ràng buộc theo nốt (Phase 5).
 * Không có nút "Tạo" giả: nút bị khóa kèm lý do cụ thể.
 */
import { useMemo, useState } from 'react';
import { keyAt, ScoreIndex, timeSigAt, type ChordEvent } from '@holy-melody/music-core';
import { useActiveProject, useStore } from '../state/store';
import { IconMic } from '../components/icons';

const VOICES = ['Nữ (Female)', 'Nam (Male)', 'Soprano', 'Alto', 'Tenor', 'Bass', 'Ca đoàn (Choir)', 'Song ca (Duet)'];
const STYLES = ['Sacred Hymn', 'Worship', 'Ballad', 'Acoustic', 'Piano', 'Choir', 'Classical', 'Orchestral', 'Gregorian-inspired', 'Gospel', 'Pop', 'Guitar', 'Jazz'];
const KEY_NAMES: Record<number, string> = { [-7]: 'Cb', [-6]: 'Gb', [-5]: 'Db', [-4]: 'Ab', [-3]: 'Eb', [-2]: 'Bb', [-1]: 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#' };

export function SingerCenter() {
  const project = useActiveProject();
  useStore((s) => s.revision); // luôn đọc bản mới nhất của bản nhạc
  const [voice, setVoice] = useState(VOICES[0]!);
  const [style, setStyle] = useState(STYLES[0]!);
  const [strict, setStrict] = useState(true);

  const analysis = useMemo(() => {
    if (!project) return null;
    const s = project.score;
    const idx = new ScoreIndex(s);
    const melodyPart = s.parts[0];
    let notes = 0;
    let withLyrics = 0;
    let phrases = 0;
    const lyricLine: string[] = [];
    if (melodyPart) {
      for (const m of s.measures) {
        const v = melodyPart.content[m.id]?.[0];
        for (const e of v?.events ?? []) {
          if (e.kind === 'rest') {
            if (lyricLine.length && lyricLine[lyricLine.length - 1] !== '/') { lyricLine.push('/'); phrases++; }
            continue;
          }
          const c = e as ChordEvent;
          if (c.notes[0]?.tieStop) continue;
          notes++;
          const l = c.lyrics.find((x) => x.verse === 1);
          if (l) {
            withLyrics++;
            lyricLine.push(l.text + (l.syllabic === 'begin' || l.syllabic === 'middle' ? '-' : ''));
          }
        }
      }
    }
    const k = keyAt(s, 0);
    const ts = timeSigAt(s, 0);
    return {
      title: s.meta.title, revision: s.revision, notes, withLyrics, phrases: phrases + (lyricLine.length ? 1 : 0),
      key: `${KEY_NAMES[k.fifths] ?? k.fifths} ${k.mode === 'minor' ? 'thứ' : 'trưởng'}`,
      time: `${ts.beats}/${ts.beatType}`, tempo: s.tempoMap[0]?.bpm ?? 0, parts: s.parts.map((p) => p.name),
      lyrics: lyricLine.join(' ').replace(/ \/ /g, ' / '),
      totalNotes: idx.allNoteIds().length,
    };
  }, [project, project?.score.revision]);

  if (!project || !analysis) return <div className="flex-1 grid place-items-center text-muted">Chưa mở bản nhạc nào</div>;
  const coverage = analysis.notes ? Math.round((analysis.withLyrics / analysis.notes) * 100) : 0;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl mx-auto space-y-5 hm-enter">
        <header className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-accent-soft text-accent grid place-items-center"><IconMic size={20} /></div>
          <div>
            <h1 className="text-lg font-semibold">AI Singer Studio</h1>
            <p className="text-muted text-xs">Dữ liệu lấy trực tiếp từ bản nhạc đang mở (revision {analysis.revision}).</p>
          </div>
        </header>

        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="font-semibold mb-3">1. Phân tích bản nhạc</h2>
          <dl className="grid grid-cols-3 gap-3 text-[12px]">
            {[
              ['Bài', analysis.title], ['Giọng', analysis.key], ['Nhịp', analysis.time],
              ['Tempo', `♩ = ${analysis.tempo}`], ['Nốt giai điệu', String(analysis.notes)], ['Câu nhạc', String(analysis.phrases)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-surface-2 p-2"><dt className="text-muted text-[11px]">{k}</dt><dd className="font-medium truncate">{v}</dd></div>
            ))}
          </dl>
          <div className="mt-3">
            <div className="flex justify-between text-[11px] text-muted mb-1"><span>Nốt có lời ca</span><span>{coverage}%</span></div>
            <div className="h-1.5 rounded-full bg-surface-2"><div className="h-full rounded-full bg-play" style={{ width: `${coverage}%` }} /></div>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed bg-surface-2 rounded-lg p-2 min-h-10" lang="vi">
            {analysis.lyrics || <span className="text-muted">Bài chưa có lời. Hãy nhập lời trong Score Editor trước khi tạo bài hát.</span>}
          </p>
        </section>

        <section className="rounded-xl border border-line bg-surface p-4 grid grid-cols-2 gap-4">
          <div>
            <h2 className="font-semibold mb-2">2. Giọng hát</h2>
            <div className="flex flex-wrap gap-1.5">
              {VOICES.map((v) => (
                <button key={v} onClick={() => setVoice(v)} className={`px-2.5 py-1 rounded-full border text-[12px] transition ${voice === v ? 'bg-accent text-accent-fg border-accent' : 'border-line hover:bg-surface-2'}`}>{v}</button>
              ))}
            </div>
          </div>
          <div>
            <h2 className="font-semibold mb-2">3. Phong cách</h2>
            <select className="w-full h-8 rounded-md border border-line bg-surface px-2" value={style} onChange={(e) => setStyle(e.target.value)}>
              {STYLES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <label className="col-span-2 flex items-start gap-2 rounded-lg bg-surface-2 p-3">
            <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-medium">Strict Melody Mode</span>
              <span className="block text-[11px] text-muted">Giữ đúng cao độ, trường độ, câu và thứ tự lời. Chỉ dùng provider tổng hợp giọng hát theo nốt; không gửi prompt văn bản cho dịch vụ text-to-music.</span>
            </span>
          </label>
        </section>

        <section className="rounded-xl border border-dashed border-line p-4 flex items-center gap-4">
          <div className="flex-1 text-[12px]">
            <div className="font-semibold">Chi phí: 10 credit / lần tạo</div>
            <div className="text-muted mt-0.5">
              Chưa thể tạo: cần đăng nhập Google, và chưa có provider tổng hợp giọng hát tiếng Việt có ràng buộc theo nốt được cấu hình (Phase 5–6).
            </div>
          </div>
          <button disabled className="h-10 px-5 rounded-lg bg-accent text-accent-fg font-semibold opacity-40 cursor-not-allowed" title="Tính năng chưa được kích hoạt">
            Tạo bài hát
          </button>
        </section>
      </div>
    </div>
  );
}
