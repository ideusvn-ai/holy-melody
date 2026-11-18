/**
 * Đối chiếu (human-in-the-loop): so ảnh gốc của ô nhịp với nốt đã nhận dạng, sửa trong khuông nhạc,
 * rồi xác nhận một lần. Kết quả, cách nhận dạng và tọa độ vùng ảnh được lưu vĩnh viễn trong dự án.
 */
import { useEffect, useMemo, useState } from 'react';
import { applyMissedKey, autoFixIssues, recordReview, reviewIssues, type RuleIssue } from '@holy-melody/music-core';
import { useActiveProject, useStore } from '../state/store';
import { cropUrl, getSheetAsset, measureBox, rerecognizeSystem } from '../lib/sheet';

const STATUS_LABEL = { confirmed: 'Đã xác nhận', corrected: 'Đã sửa', rerecognized: 'Đã nhận dạng lại', flagged: 'Cần xem' } as const;

export function ReviewPanel() {
  const project = useActiveProject();
  const st = useStore();
  const revision = useStore((s) => s.revision);
  const [busy, setBusy] = useState(false);
  const [img, setImg] = useState<string | null>(null);
  const [keyPick, setKeyPick] = useState(-1);
  const score = project?.score;
  const sheet = score?.sheet;
  const issues = useMemo(() => (score ? reviewIssues(score) : []), [score, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const mi = st.selection.measureRange?.[0] ?? null;
  const m = mi !== null ? score?.measures[mi] : undefined;
  const asset = score ? getSheetAsset(score.id) : undefined;
  const box = score && mi !== null ? measureBox(score, mi) : null;

  useEffect(() => {
    setImg(null);
    if (!score || !asset || !box) return;
    let live = true;
    void cropUrl(score.id, asset, box).then((u) => live && setImg(u)).catch(() => undefined);
    return () => { live = false; };
  }, [score?.id, asset, box?.x, box?.y, box?.page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!score || !sheet) return <p className="p-3 text-muted text-[12px]">Chỉ dùng cho bản nhạc mở từ ảnh/PDF.</p>;

  const byMeasure = new Map<number, RuleIssue[]>();
  for (const i of issues) byMeasure.set(i.measureIndex, [...(byMeasure.get(i.measureIndex) ?? []), i]);
  const queue = score.measures
    .map((mm, k) => ({ k, mm, review: sheet.reviews[mm.id], n: byMeasure.get(k)?.length ?? 0 }))
    .filter((x) => x.n > 0 || x.review?.status === 'flagged');
  const done = score.measures.filter((mm) => sheet.reviews[mm.id] && sheet.reviews[mm.id]!.status !== 'flagged').length;
  const mine = mi !== null ? byMeasure.get(mi) ?? [] : [];
  const review = m ? sheet.reviews[m.id] : undefined;
  const g = mi !== null ? sheet.measures.find((x) => x.measureIndex === mi) : undefined;

  const confirm = () => {
    if (!m || mi === null || !box) return;
    const before = review?.issues.length ?? 0;
    st.exec(recordReview({
      measureId: m.id,
      status: review && (review.status === 'rerecognized' || before > mine.length) ? (review.status === 'rerecognized' && before <= mine.length ? 'rerecognized' : 'corrected') : 'confirmed',
      box, issues: [...new Set(mine.map((i) => i.code))],
      engine: review?.engine && review.engine !== 'audiveris' ? review.engine : before > mine.length ? 'manual' : 'audiveris',
      at: new Date().toISOString(),
    }));
    const next = queue.find((x) => x.k > mi && x.k !== mi);
    if (next) st.select({ measureRange: [next.k, next.k], noteIds: [], eventIds: [] });
  };
  const flag = () => {
    if (!m || !box) return;
    st.exec(recordReview({ measureId: m.id, status: 'flagged', box, issues: [...new Set(mine.map((i) => i.code))], engine: review?.engine ?? 'audiveris', at: new Date().toISOString() }));
  };
  const rerun = async () => {
    if (!g || mi === null) return;
    setBusy(true);
    try {
      const ok = await rerecognizeSystem(score, g.system, [mi], (c) => st.exec(c));
      st.notify(ok ? 'Đã nhận dạng lại ô này với cấu hình khác: ít lỗi hơn.' : 'Nhận dạng lại không cho kết quả tốt hơn — hãy sửa trực tiếp trong khuông nhạc.');
    } finally {
      setBusy(false);
    }
  };
  const fixSafe = () => {
    const safe = mine.filter((i) => i.autoFix && !i.special);
    if (safe.length) st.exec(autoFixIssues(safe));
  };
  const btn = 'h-8 px-2.5 rounded-md border border-line hover:bg-surface-2 disabled:opacity-40 text-[12px]';

  return (
    <div className="p-3 space-y-3 text-[12px]">
      <div>
        <div className="flex justify-between text-muted text-[11px] mb-1"><span>Đã đối chiếu</span><span>{done}/{score.measures.length} ô</span></div>
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden"><div className="h-full bg-play" style={{ width: `${(100 * done) / Math.max(1, score.measures.length)}%` }} /></div>
      </div>

      {m && mi !== null ? (
        <section className="space-y-2 rounded-lg border border-line p-2">
          <div className="flex items-center gap-2">
            <b>Ô {m.number}</b>
            {review && <span className="text-[10.5px] px-1.5 rounded bg-surface-2">{STATUS_LABEL[review.status]}{review.engine.startsWith('audiveris-region') ? ' · vùng' : ''}</span>}
            {mine.some((i) => i.special) && <span className="text-[10.5px] px-1.5 rounded bg-accent-soft">{({ pickup: 'Lấy đà', cadenza: 'Cadenza', irregular: 'Ký âm đặc biệt' } as const)[mine.find((i) => i.special)!.special!]} · không tự sửa</span>}
          </div>
          <div className="rounded-md border border-line bg-white min-h-16 grid place-items-center overflow-hidden">
            {img ? <img src={img} alt={`Ảnh gốc ô ${m.number}`} className="max-w-full max-h-72 object-contain" /> : <span className="text-muted text-[11px] p-3">{asset ? (box ? 'Đang cắt ảnh gốc…' : 'Không có tọa độ ô này') : 'Không có file gốc'}</span>}
          </div>
          <p className="text-[10.5px] text-muted">Trên: ảnh gốc. Ô đang chọn trong khuông nhạc là kết quả nhận dạng — sửa trực tiếp ở đó.</p>
          {mine.length ? (
            <ul className="space-y-1">{mine.map((i, k) => <li key={k} className={i.severity === 'error' ? 'text-warn' : ''}>• {i.message}</li>)}</ul>
          ) : <p className="text-play">Không có lỗi quy tắc.</p>}
          {mine.some((i) => i.code === 'KEY_SUSPECT') && (
            <div className="flex items-center gap-1.5 rounded-md bg-accent-soft p-2">
              <span className="flex-1">Hoá biểu trên ảnh gốc:</span>
              <select className="h-7 rounded border border-line bg-surface px-1" value={keyPick} onChange={(e) => setKeyPick(Number(e.target.value))} aria-label="Hoá biểu">
                {[-7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7].map((f) => <option key={f} value={f}>{Math.abs(f)} {f < 0 ? 'giáng' : 'thăng'}</option>)}
              </select>
              <button className="h-7 px-2 rounded-md bg-accent text-accent-fg" onClick={() => {
                st.exec(applyMissedKey(mi, keyPick));
                if (box && m) st.exec(recordReview({ measureId: m.id, status: 'corrected', box, issues: ['KEY_SUSPECT'], engine: 'manual', at: new Date().toISOString() }));
                st.notify('Đã đặt hoá biểu và sửa cao độ các nốt không có dấu hoá riêng.');
              }}>Áp dụng</button>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <button className="h-8 px-3 rounded-md bg-accent text-accent-fg font-semibold" onClick={confirm}>Đúng với bản gốc</button>
            <button className={btn} onClick={fixSafe} disabled={!mine.some((i) => i.autoFix && !i.special)}>Tự sửa lỗi an toàn</button>
            <button className={btn} onClick={() => void rerun()} disabled={busy || !g || !asset}>{busy ? 'Đang nhận dạng…' : 'Nhận dạng lại vùng này'}</button>
            <button className={btn} onClick={flag}>Để sau</button>
          </div>
        </section>
      ) : (
        <p className="text-muted">Chọn một ô trong danh sách hoặc trong khuông nhạc để đối chiếu với ảnh gốc.</p>
      )}

      <section>
        <h3 className="text-[11px] uppercase tracking-wide text-muted mb-1">Cần đối chiếu ({queue.length})</h3>
        <ul className="space-y-0.5 max-h-72 overflow-auto">
          {queue.map((x) => (
            <li key={x.mm.id}>
              <button className={`w-full text-left px-2 py-1 rounded hover:bg-surface-2 flex gap-2 ${x.k === mi ? 'bg-accent-soft' : ''}`}
                onClick={() => st.select({ measureRange: [x.k, x.k], noteIds: [], eventIds: [] })}>
                <span className="w-12">Ô {x.mm.number}</span>
                <span className="flex-1 truncate text-muted">{byMeasure.get(x.k)?.[0]?.message ?? 'Đánh dấu để xem lại'}</span>
                {x.n > 0 && <span className="text-warn">{x.n}</span>}
              </button>
            </li>
          ))}
          {!queue.length && <li className="text-play px-2">Không còn ô nào cần xem. 🎉</li>}
        </ul>
      </section>
    </div>
  );
}

/** Editor khi bản nhạc ảnh/PDF chưa được chuyển: chưa dựng khuông nhạc */
export function EditGate({ onConvert }: { onConvert: () => void }) {
  return (
    <div className="flex-1 grid place-items-center bg-surface-2 p-8">
      <div className="max-w-md text-center space-y-3">
        <h2 className="text-[16px] font-semibold">Bản nhạc đang ở chế độ xem bản gốc</h2>
        <p className="text-muted text-[13px]">Player đang phát trực tiếp trên ảnh/PDF gốc. Để biên tập, Holy Melody cần dựng khuông nhạc đầy đủ. Bước này có kiểm tra quy tắc, nhận dạng lại vùng khó và đối chiếu với ảnh gốc.</p>
        <button className="h-10 px-5 rounded-md bg-accent text-accent-fg font-semibold" onClick={onConvert}>Chuyển sang Editor</button>
        <p className="text-[11px] text-muted">Mỗi file gốc chỉ bị trừ credit một lần.</p>
      </div>
    </div>
  );
}
