/**
 * AI Singer Studio: hát bản nhạc đang mở bằng giọng tổng hợp.
 * Giọng đọc từng âm tiết do OpenAI TTS tạo (máy chủ giữ API key, lưu đệm âm tiết); ứng dụng tự đặt cao độ/trường độ
 * từng nốt (TD-PSOLA), luyến, rung giọng và trộn với đệm đàn SoundFont. Nghe thử 12 âm tiết đầu miễn phí.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { keyAt, timeSigAt, versesOf } from '@holy-melody/music-core';
import { useAccount } from '../state/account';
import { useActiveProject, useStore } from '../state/store';
import { IconMic } from '../components/icons';
import { saveBytes } from '../lib/fileio';
import { lyricPartOf, plansFor, renderSong, SINGER_VOICES, voiceAssignments, type Accomp, type SingerMode } from '../lib/singer';

const STYLES = [
  ['Thánh ca trang nghiêm', 'hát thánh ca, trang nghiêm, sốt sắng, giọng tròn và ấm'],
  ['Nhẹ nhàng, tha thiết', 'hát nhẹ nhàng, tha thiết, mềm mại'],
  ['Hợp xướng', 'giọng hợp xướng cổ điển, đầy đặn, vang'],
  ['Trong sáng, tươi vui', 'hát trong sáng, tươi vui, rõ lời'],
] as const;
const KEY_NAMES: Record<number, string> = { [-7]: 'Cb', [-6]: 'Gb', [-5]: 'Db', [-4]: 'Ab', [-3]: 'Eb', [-2]: 'Bb', [-1]: 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#' };
const PREVIEW = 12;

export function SingerCenter() {
  const project = useActiveProject();
  useStore((s) => s.revision);
  const notify = useStore((s) => s.notify);
  const acc = useAccount();
  const score = project?.score;
  const [mode, setMode] = useState<SingerMode>('solo');
  const [partId, setPartId] = useState('');
  const [verse, setVerse] = useState(1);
  const [voice, setVoice] = useState<string>('coral');
  const [style, setStyle] = useState(0);
  const [accomp, setAccomp] = useState<Accomp>('chords');
  const [transpose, setTranspose] = useState(0);
  const [info, setInfo] = useState<{ enabled: boolean; credits: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; wav: Uint8Array; seconds: number; preview: boolean; note: string } | null>(null);
  const idem = useRef(new Map<string, string>());

  const pid = partId && score?.parts.some((p) => p.id === partId) ? partId : score ? lyricPartOf(score, score.parts[0]?.id ?? '') : '';
  const verses = score && pid ? versesOf(score, pid) : [];
  useEffect(() => {
    if (!acc.configured) return;
    acc.api<{ enabled: boolean; credits: number }>('GET', '/api/v1/singer/info').then(setInfo).catch(() => setInfo({ enabled: false, credits: 10 }));
  }, [acc.configured]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);

  const opts = { mode, partId: pid, verse, voice, style: STYLES[style]![1], accompaniment: accomp, transpose };
  const plans = useMemo(() => (score && pid ? plansFor(score, opts) : []), [score, score?.revision, pid, mode, verse, voice, transpose]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project || !score) return <div className="flex-1 grid place-items-center text-muted">Chưa mở bản nhạc nào</div>;
  const main = plans[0]?.plan;
  const sung = main ? main.syllables.length : 0;
  const coverage = main && main.totalNotes ? Math.round(((main.totalNotes - main.silent) / main.totalNotes) * 100) : 0;
  const k = keyAt(score, 0);
  const ts = timeSigAt(score, 0);
  const voicesUsed = [...new Set(voiceAssignments(score, opts).map((a) => a.voice))].length;
  const cost = acc.unlimited ? 0 : (info?.credits ?? 10) * voicesUsed;
  const reason = !acc.configured ? acc.reason ?? 'Chưa cấu hình máy chủ'
    : !acc.user ? 'Cần đăng nhập Google để dùng AI Singer.'
    : info && !info.enabled ? 'Máy chủ chưa bật OpenAI (HM_OPENAI_API_KEY). Bạn không bị trừ credit.'
    : !sung ? 'Bài chưa có lời ca: nhập lời trong Score Editor (bảng "Lời ca") trước.'
    : null;

  const run = async (preview: boolean) => {
    setBusy(preview ? 'Đang nghe thử…' : 'Đang tạo bài hát…');
    try {
      const r = await renderSong(score, { ...opts, previewSyllables: preview ? PREVIEW : undefined },
        (body, key) => acc.api('POST', '/api/v1/singer/voice', body, key),
        (v) => {
          const key = `${v}|${preview}`;
          if (!idem.current.has(key)) idem.current.set(key, crypto.randomUUID());
          return idem.current.get(key)!;
        },
        (p) => setBusy(p.text));
      for (const k2 of [...idem.current.keys()]) if (k2.endsWith(`|${preview}`)) idem.current.delete(k2);
      if (result) URL.revokeObjectURL(result.url);
      const url = URL.createObjectURL(new Blob([r.wav as BlobPart], { type: 'audio/wav' }));
      setResult({ url, wav: r.wav, seconds: r.seconds, preview, note: r.missing.length ? `Thiếu ${r.missing.length} âm tiết (${r.missing.slice(0, 5).join(', ')}) — các nốt đó để trống.` : '' });
      void acc.refresh();
      notify(preview ? 'Đã tạo bản nghe thử (miễn phí).' : `Đã tạo bài hát${r.credits ? ` (−${r.credits} credit)` : ''}.`);
    } catch (e) {
      const m = String((e as Error).message ?? e);
      notify(/INSUFFICIENT/i.test(m) ? 'Không đủ credit. Mua thêm ở menu tài khoản.' : m, 'error');
    } finally {
      setBusy(null);
    }
  };

  const chip = (on: boolean) => `px-2.5 py-1 rounded-full border text-[12px] transition ${on ? 'bg-accent text-accent-fg border-accent' : 'border-line hover:bg-surface-2'}`;
  const sel = 'w-full h-8 rounded-md border border-line bg-surface px-2';

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl mx-auto space-y-5 hm-enter">
        <header className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-accent-soft text-accent grid place-items-center"><IconMic size={20} /></div>
          <div>
            <h1 className="text-lg font-semibold">AI Singer</h1>
            <p className="text-muted text-xs">Hát đúng từng nốt và lời ca của bản nhạc đang mở (revision {score.revision}).</p>
          </div>
        </header>

        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="font-semibold mb-3">1. Bản nhạc</h2>
          <dl className="grid grid-cols-4 gap-3 text-[12px]">
            {[['Giọng', `${KEY_NAMES[k.fifths] ?? k.fifths} ${k.mode === 'minor' ? 'thứ' : 'trưởng'}`], ['Nhịp', `${ts.beats}/${ts.beatType}`], ['Tempo', `♩ = ${score.tempoMap[0]?.bpm ?? 0}`], ['Âm tiết sẽ hát', String(sung)]].map(([a, b]) => (
              <div key={a} className="rounded-lg bg-surface-2 p-2"><dt className="text-muted text-[11px]">{a}</dt><dd className="font-medium truncate">{b}</dd></div>
            ))}
          </dl>
          <div className="mt-3">
            <div className="flex justify-between text-[11px] text-muted mb-1"><span>Nốt có lời (bè chính)</span><span>{coverage}%</span></div>
            <div className="h-1.5 rounded-full bg-surface-2"><div className="h-full rounded-full bg-play" style={{ width: `${coverage}%` }} /></div>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed bg-surface-2 rounded-lg p-2 min-h-10 max-h-24 overflow-auto" lang="vi">
            {main?.syllables.map((s) => s.text).join(' ') || <span className="text-muted">Bài chưa có lời ca ở lời {verse}.</span>}
          </p>
        </section>

        <section className="rounded-xl border border-line bg-surface p-4 grid grid-cols-2 gap-4 text-[12.5px]">
          <div className="col-span-2">
            <h2 className="font-semibold mb-2">2. Cách hát</h2>
            <div className="flex gap-1.5">
              {([['solo', 'Đơn ca'], ['duet', 'Song ca'], ['choir', `Ca đoàn (${Math.min(4, score.parts.length)} bè)`]] as const).map(([m, l]) => (
                <button key={m} className={chip(mode === m)} onClick={() => setMode(m)} disabled={m === 'choir' && score.parts.length < 2}>{l}</button>
              ))}
            </div>
          </div>
          {mode === 'solo' ? (
            <>
              <label className="block">
                <span className="block text-[11px] uppercase tracking-wide text-muted mb-1">Bè hát</span>
                <select className={sel} value={pid} onChange={(e) => setPartId(e.target.value)}>
                  {score.parts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <div>
                <span className="block text-[11px] uppercase tracking-wide text-muted mb-1">Giọng</span>
                <div className="flex flex-wrap gap-1.5">
                  {SINGER_VOICES.map((v) => <button key={v.id} className={chip(voice === v.id)} onClick={() => setVoice(v.id)}>{v.label}</button>)}
                </div>
              </div>
            </>
          ) : (
            <p className="col-span-2 text-[11.5px] text-muted">
              {voiceAssignments(score, opts).map((a) => `${a.name || 'Bè'} → ${SINGER_VOICES.find((v) => v.id === a.voice)?.label ?? a.voice}`).join(' · ')}.
              Bè không có lời mượn lời của bè giai điệu tại cùng thời điểm.
            </p>
          )}
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wide text-muted mb-1">Lời</span>
            <select className={sel} value={verse} onChange={(e) => setVerse(Number(e.target.value))}>
              {(verses.length ? verses : [1]).map((v) => <option key={v} value={v}>Lời {v}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wide text-muted mb-1">Phong cách</span>
            <select className={sel} value={style} onChange={(e) => setStyle(Number(e.target.value))}>
              {STYLES.map(([l], i) => <option key={l} value={i}>{l}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wide text-muted mb-1">Đệm đàn</span>
            <select className={sel} value={accomp} onChange={(e) => setAccomp(e.target.value as Accomp)}>
              <option value="chords">Đệm hợp âm + dạo đầu</option>
              <option value="full">Đệm + giai điệu nhạc cụ</option>
              <option value="none">Không đệm (chỉ giọng hát)</option>
            </select>
          </label>
          <div>
            <span className="block text-[11px] uppercase tracking-wide text-muted mb-1">Dịch giọng</span>
            <div className="flex items-center gap-2">
              <button className="h-8 w-8 rounded-md border border-line hover:bg-surface-2" onClick={() => setTranspose(Math.max(-12, transpose - 1))} aria-label="Hạ nửa cung">−</button>
              <span className="flex-1 text-center tabular-nums">{transpose > 0 ? `+${transpose}` : transpose} nửa cung</span>
              <button className="h-8 w-8 rounded-md border border-line hover:bg-surface-2" onClick={() => setTranspose(Math.min(12, transpose + 1))} aria-label="Nâng nửa cung">+</button>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-dashed border-line p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex-1 text-[12px]">
              <div className="font-semibold">{acc.unlimited ? 'Tài khoản quản trị: không giới hạn' : `Chi phí: ${cost} credit / lần tạo cả bài`}{acc.balance !== null && !acc.unlimited ? ` · Số dư: ${acc.balance}` : ''}</div>
              <div className="text-muted mt-0.5">{busy ?? reason ?? `Nghe thử ${PREVIEW} âm tiết đầu miễn phí trước khi tạo cả bài.`}</div>
            </div>
            <button disabled={!!reason || !!busy} onClick={() => void run(true)} className="h-10 px-4 rounded-lg border border-line font-medium disabled:opacity-40">Nghe thử</button>
            <button disabled={!!reason || !!busy} onClick={() => void run(false)} className="h-10 px-5 rounded-lg bg-accent text-accent-fg font-semibold disabled:opacity-40">Tạo bài hát</button>
          </div>
          {result && (
            <div className="rounded-lg bg-surface-2 p-3 space-y-2">
              <div className="flex items-center gap-3">
                <audio src={result.url} controls className="flex-1 h-9" />
                <button className="h-9 px-3 rounded-md border border-line hover:bg-surface text-[12px]"
                  onClick={() => void saveBytes(`${(score.meta.title || 'bai-hat').replace(/[\\/:*?"<>|]+/g, '-')}${result.preview ? ' (nghe thu)' : ''}.wav`, result.wav, 'audio/wav', [{ name: 'WAV', extensions: ['wav'] }])}>
                  Lưu WAV
                </button>
              </div>
              <p className="text-[11px] text-muted">{result.preview ? 'Bản nghe thử. ' : ''}{Math.round(result.seconds)} giây. {result.note}</p>
            </div>
          )}
          <p className="text-[11px] text-muted leading-relaxed">
            Giọng được dựng từ giọng đọc tiếng Việt của OpenAI rồi chỉnh cao độ/trường độ theo từng nốt: đúng nốt, rõ lời, có luyến và rung giọng,
            nhưng vẫn nghe "máy" hơn ca sĩ thật — phù hợp để tập hát, dò bè. Lỗi do hệ thống được hoàn credit tự động.
          </p>
        </section>
      </div>
    </div>
  );
}
