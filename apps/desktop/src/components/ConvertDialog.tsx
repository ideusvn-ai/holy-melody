/**
 * Chuyển bản nhạc ảnh/PDF sang chế độ biên tập: trừ credit theo giá máy chủ (mặc định 50; admin miễn phí) (máy chủ, đúng một lần cho mỗi file gốc),
 * kiểm tra quy tắc âm nhạc, nhận dạng lại các vùng lỗi, rồi mở Score Editor với bảng Đối chiếu.
 */
import { useEffect, useRef, useState } from 'react';
import { useActiveProject, useStore } from '../state/store';
import { useAccount } from '../state/account';
import { convertToEdit, type ConvertProgress } from '../lib/sheet';

export function ConvertDialog({ onClose }: { onClose: () => void }) {
  const project = useActiveProject();
  const st = useStore();
  const acc = useAccount();
  const [prog, setProg] = useState<ConvertProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => { if (acc.configured) void acc.loadEditPrice(); }, [acc.configured]);
  const priceText = acc.unlimited ? 'miễn phí (tài khoản quản trị)' : `${acc.editPrice ?? 50} credit`;
  const sheet = project?.score.sheet;
  if (!project || !sheet) return null;
  const already = !!sheet.conversion;
  const running = !!prog && prog.phase !== 'done' && !error;

  const run = async () => {
    setError(null);
    cancelled.current = false;
    // AI (OpenAI trên máy chủ) có bật không — không có thì dùng nhận dạng kỹ + nhận dạng lại theo vùng
    const aiOn = await acc.api<{ enabled: boolean }>('GET', '/api/v1/omr/ai-status').then((r) => r.enabled).catch(() => false);
    try {
      const r = await convertToEdit(
        project.score,
        (cmd) => st.exec(cmd),
        async () => {
          const res = await acc.api<{ credits: number; transaction_id: number | null; created_at: string; balance: number }>(
            'POST', '/api/v1/omr/edit-conversions',
            { source_hash: sheet.hash, title: project.score.meta.title, pages: sheet.pages.length, measures: project.score.measures.length },
            `omr-edit-${sheet.hash.slice(0, 48)}`,
          );
          useAccount.setState({ balance: res.balance });
          return res;
        },
        setProg,
        () => cancelled.current,
        {
          enabled: aiOn,
          region: (req) => acc.api<{ musicxml: string; model: string }>('POST', '/api/v1/omr/ai-region', { source_hash: sheet.hash, ...req }),
          lyrics: (req) => acc.api<{ verses: string[][]; model: string }>('POST', '/api/v1/omr/ai-lyrics', { source_hash: sheet.hash, ...req }),
        },
      );
      const flagged = new Set(r.issues.filter((i) => i.severity === 'error').map((i) => i.measureIndex)).size;
      st.setTab('editor');
      st.notify(
        `Đã dựng khuông nhạc. Tự sửa ${r.fixed} lỗi an toàn` +
          (r.aiTried ? `; AI rà soát ${r.aiTried} dòng: sửa ${r.aiImproved} ô, đọc lời ca ${r.aiLyrics} dòng, ${r.aiDiffs} ô đọc khác cần xem` : '') +
          (r.regionsTried ? `; nhận dạng lại ${r.regionsTried} vùng (${r.regionsImproved} vùng tốt hơn)` : '') +
          (r.aiNote && !r.aiTried ? ` (AI lỗi: ${r.aiNote})` : '') + '. ' +
          (flagged ? `Còn ${flagged} ô cần bạn đối chiếu ở bảng "Đối chiếu".` : 'Không còn ô nào lỗi quy tắc — vẫn nên đối chiếu nhanh với bản gốc.'),
      );
      onClose();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(/INSUFFICIENT/i.test(msg) ? 'Không đủ credit. Hãy mua thêm credit ở menu tài khoản rồi thử lại.' : msg);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 grid place-items-center" role="dialog" aria-label="Chuyển sang Edit">
      <div className="w-[520px] rounded-xl border border-line bg-surface shadow-2xl p-5 space-y-4 hm-enter text-[13px]">
        <header>
          <h2 className="font-semibold text-[15px]">Chuyển sang Edit</h2>
          <p className="text-muted text-[12px] mt-0.5 truncate">{sheet.fileName}</p>
        </header>
        <ul className="space-y-1.5 text-[12.5px]">
          <li>• <b>Nhận dạng tiếp</b> các trang/vùng còn thiếu ở độ phân giải gốc.</li>
          <li>• <b>Kiểm tra quy tắc</b>: trường độ ô nhịp, dấu hoá, dấu nối, phân bè. Chỉ tự sửa lỗi an toàn; ô lấy đà, cadenza và ký âm đặc biệt được giữ nguyên.</li>
          <li>• <b>AI (OpenAI) rà soát từng dòng</b> song song: đọc <b>lời ca tiếng Việt</b> và so từng nốt với ảnh gốc. Chỉ nhận sửa khi lỗi giảm; ô AI đọc khác được đưa vào danh sách đối chiếu.</li>
          <li>• <b>Đối chiếu</b>: bạn so từng ô với ảnh gốc, sửa một lần. Kết quả và tọa độ được lưu luôn trong dự án.</li>
        </ul>
        <div className="rounded-md bg-surface-2 px-3 py-2 text-[12px]">
          {already ? (
            <>Bản nhạc này đã chuyển trước đây ({new Date(sheet.conversion!.at).toLocaleString('vi-VN')}): <b>không trừ thêm credit</b>.</>
          ) : acc.user ? (
            <>Phí: <b>{priceText}</b>{!acc.unlimited && <> · số dư hiện tại: <b>{acc.balance ?? '…'}</b></>}. Mở lại chính file này sau đó không bị trừ thêm.</>
          ) : (
            <>Phí: <b>{priceText}</b>. Cần đăng nhập để trừ credit (Player vẫn dùng được không cần đăng nhập).</>
          )}
        </div>
        {prog && !error && (
          <div className="space-y-1">
            <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${prog.phase === 'charge' ? 4 : prog.phase === 'full' ? 15 : prog.phase === 'validate' ? 35 : prog.phase === 'done' ? 100 : (prog.phase === 'ai' ? 38 : 70) + (prog.phase === 'ai' ? 55 : 25) * prog.done / Math.max(1, prog.total)}%` }} />
            </div>
            <p className="text-[11px] text-muted truncate">{prog.text}</p>
          </div>
        )}
        {error && <pre className="text-[11px] whitespace-pre-wrap bg-warn/10 text-warn rounded-md p-2 max-h-40 overflow-auto">{error}</pre>}
        <footer className="flex justify-end gap-2">
          {running ? (
            <button className="h-9 px-4 rounded-md border border-line hover:bg-surface-2" onClick={() => (cancelled.current = true)}>Bỏ qua phần nhận dạng lại</button>
          ) : (
            <button className="h-9 px-4 rounded-md border border-line hover:bg-surface-2" onClick={onClose}>Huỷ</button>
          )}
          {!already && !acc.user ? (
            <button className="h-9 px-4 rounded-md bg-accent text-accent-fg font-semibold disabled:opacity-50" disabled={acc.busy || acc.configured === false}
              onClick={() => void acc.login().catch((e) => setError(String(e.message ?? e)))}>
              {acc.configured === false ? (acc.reason ?? 'Chưa cấu hình tài khoản') : 'Đăng nhập Google'}
            </button>
          ) : (
            <button className="h-9 px-4 rounded-md bg-accent text-accent-fg font-semibold disabled:opacity-50" disabled={running} onClick={() => void run()}>
              {running ? 'Đang xử lý…' : already ? 'Dựng khuông nhạc' : acc.unlimited ? 'Chuyển sang Editor' : `Dùng ${acc.editPrice ?? 50} credit và chuyển`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
