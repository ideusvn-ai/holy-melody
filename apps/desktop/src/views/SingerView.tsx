/**
 * AI Singer Studio — Phase 1: giao diện + phân tích bản nhạc cục bộ (thật).
 * Tạo giọng hát cần đăng nhập, credit và một provider SVS có ràng buộc theo nốt (Phase 5).
 * Không có nút "Tạo" giả: nút bị khóa kèm lý do cụ thể.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { exportMusicXml } from '@holy-melody/music-core';
import { useAccount } from '../state/account';
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

        <GeneratePanel style={style} voice={voice} strict={strict} coverage={coverage} />
      </div>
    </div>
  );
}


interface Job { id: number; type?: string; job_type?: string; status: string; credit_cost: number; progress: number | null; error?: { code: string; message: string } | null; created_at: string; outputs?: { id: number; kind: string; format: string; duration: number | null }[] }

const STATUS: Record<string, string> = { pending: 'Đang chờ', processing: 'Đang xử lý', completed: 'Hoàn thành', failed: 'Thất bại', cancelled: 'Đã hủy' };

function GeneratePanel({ style, voice, strict, coverage }: { style: string; voice: string; strict: boolean; coverage: number }) {
  const project = useActiveProject();
  const acc = useAccount();
  const notify = useStore((s) => s.notify);
  const [pricing, setPricing] = useState<{ job_type: string; credit_cost: number; available: boolean }[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // giữ cùng một Idempotency-Key cho tới khi tạo job thành công → bấm lại/lỗi mạng không bị trừ hai lần
  const idem = useRef<string>(crypto.randomUUID());

  const loadJobs = () => acc.api<{ items: Job[] }>('GET', '/api/v1/ai/jobs').then((r) => setJobs(r.items.filter((j) => (j.job_type ?? j.type) === 'singer'))).catch(() => {});
  useEffect(() => {
    if (!acc.configured) return;
    acc.api<{ ai: { job_type: string; credit_cost: number; available: boolean }[] }>('GET', '/api/v1/pricing').then((r) => setPricing(r.ai)).catch(() => setPricing([]));
    if (acc.user) void loadJobs();
  }, [acc.configured, acc.user]); // eslint-disable-line react-hooks/exhaustive-deps
  // theo dõi job đang chạy
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'pending' || j.status === 'processing')) return;
    const t = setInterval(() => void loadJobs().then(() => acc.refresh()), 4000);
    return () => clearInterval(t);
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const singer = pricing?.find((p) => p.job_type === 'singer');
  const cost = singer?.credit_cost ?? 10;
  const reason =
    !acc.configured ? acc.reason ?? 'Chưa cấu hình máy chủ'
    : !acc.user ? 'Cần đăng nhập Google để dùng AI.'
    : !singer?.available ? 'Máy chủ chưa bật AI Singer (chưa có nhà cung cấp tổng hợp giọng hát tiếng Việt theo nốt). Bạn sẽ không bị trừ credit.'
    : coverage < 50 ? 'Bài cần có lời ca cho phần lớn các nốt.'
    : (acc.balance ?? 0) < cost ? `Không đủ credit (cần ${cost}).`
    : null;

  const create = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const up = await acc.api<{ input_reference: string }>('POST', '/api/v1/ai/inputs', { format: 'musicxml', content: exportMusicXml(project.score) });
      const job = await acc.api<Job & { balance: number }>('POST', '/api/v1/ai/jobs', {
        type: 'singer', input_reference: up.input_reference,
        params: { style, voice, strict_melody: strict, melody_part_id: project.score.parts[0]?.id, verse: 1, score_revision: project.score.revision },
      }, idem.current);
      idem.current = crypto.randomUUID();
      notify(`Đã tạo job #${job.id} (−${job.credit_cost} credit). Có thể đóng app, kết quả vẫn được lưu.`);
      setConfirm(false);
      await acc.refresh();
      await loadJobs();
    } catch (e) {
      notify(String((e as Error).message ?? e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const cancel = (id: number) => acc.api('POST', `/api/v1/ai/jobs/${id}/cancel`).then(() => { notify('Đã hủy, credit được hoàn lại.'); void loadJobs(); void acc.refresh(); }).catch((e) => notify(String(e.message ?? e), 'error'));

  return (
    <>
      <section className="rounded-xl border border-dashed border-line p-4 flex items-center gap-4">
        <div className="flex-1 text-[12px]">
          <div className="font-semibold">Chi phí: {cost} credit / lần tạo{acc.balance !== null ? ` · Số dư: ${acc.balance}` : ''}</div>
          <div className="text-muted mt-0.5">{reason ?? 'Sẵn sàng. Job thất bại do hệ thống được hoàn credit tự động.'}</div>
        </div>
        <button disabled={!!reason || busy} onClick={() => setConfirm(true)} className="h-10 px-5 rounded-lg bg-accent text-accent-fg font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
          Tạo bài hát
        </button>
      </section>

      {jobs.length > 0 && (
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="font-semibold mb-2">Bài hát đã tạo</h2>
          <ul className="divide-y divide-line text-[12px]">
            {jobs.map((j) => (
              <li key={j.id} className="py-2 flex items-center gap-3">
                <span className="font-mono text-muted">#{j.id}</span>
                <span className="flex-1">{STATUS[j.status] ?? j.status}{j.progress != null && j.status === 'processing' ? ` · ${j.progress}%` : ''}{j.error ? ` · ${j.error.message}` : ''}</span>
                <span className="text-muted">{j.created_at}</span>
                {j.status === 'pending' && <button className="h-7 px-2 rounded border border-line" onClick={() => void cancel(j.id)}>Hủy</button>}
                {j.status === 'completed' && acc.apiUrl && <button className="h-7 px-2 rounded border border-line" onClick={() => void acc.api<Job>('GET', `/api/v1/ai/jobs/${j.id}`).then((d) => notify(`Kết quả: ${(d.outputs ?? []).map((o) => `${o.kind}.${o.format}`).join(', ') || 'không có file'} — tải trong trang tài khoản trên website.`))}>Kết quả</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 bg-black/30 grid place-items-center" role="dialog">
          <div className="w-[420px] rounded-xl bg-surface border border-line p-5 space-y-3 hm-enter">
            <h3 className="font-semibold">Xác nhận tạo bài hát</h3>
            <p className="text-[13px]">Giọng <b>{voice}</b>, phong cách <b>{style}</b>{strict ? ', Strict Melody Mode' : ''}. Sẽ trừ <b>{cost} credit</b> (còn {(acc.balance ?? 0) - cost} sau khi tạo).</p>
            <div className="flex justify-end gap-2">
              <button className="h-9 px-4 rounded-md border border-line" onClick={() => setConfirm(false)} disabled={busy}>Hủy</button>
              <button className="h-9 px-4 rounded-md bg-accent text-accent-fg font-semibold" onClick={() => void create()} disabled={busy}>{busy ? 'Đang gửi…' : 'Xác nhận'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
