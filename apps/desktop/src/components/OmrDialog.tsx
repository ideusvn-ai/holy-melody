/**
 * Mở ảnh/PDF: Audiveris (đóng gói kèm) nhận dạng để tạo lớp phủ phát MIDI trên bản gốc. Hiển thị 10 bước,
 * tiến trình thật từ Audiveris. Khuông nhạc đầy đủ chỉ được dựng khi người dùng "Chuyển sang Edit".
 */
import { useEffect, useState } from 'react';
import { tauriInvoke } from '../lib/fileio';
import { openSheet } from '../lib/sheet';
import { useStore } from '../state/store';

const STEPS = [
  'Đọc file', 'Phân tích trang', 'Nhận dạng khuông nhạc', 'Nhận dạng khóa nhạc', 'Nhận dạng nốt và dấu hóa',
  'Nhận dạng trường độ và dấu lặng', 'Nhận dạng nhịp và ô nhịp', 'Nhận dạng lời ca', 'Chuyển đổi sang MusicXML', 'Kiểm tra và hiển thị kết quả',
];


export function OmrDialog({ file, onClose }: { file: File; onClose: () => void }) {
  const st = useStore();
  const [engine, setEngine] = useState<{ found: boolean; path?: string; downloadUrl: string } | null>(null);
  const [stage, setStage] = useState(0);
  const [line, setLine] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const invoke = tauriInvoke();

  useEffect(() => {
    if (!invoke) return;
    void (invoke('omr_detect') as Promise<{ found: boolean; path?: string; downloadUrl: string }>).then(setEngine);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setRunning(true);
    setError(null);
    setStage(1);
    try {
      const score = await openSheet(file, (stg, ln) => {
        if (stg) setStage((x) => Math.max(x, stg));
        setLine(ln.slice(0, 140));
      });
      setStage(10);
      st.newProject(score, file.name);
      st.setTab('player');
      st.notify(score.sheet?.measures.length
        ? 'Đã mở bản gốc. Bấm Phát để nghe, nốt đang phát được tô sáng ngay trên ảnh. Khi cần sửa: "Chuyển sang Edit".'
        : 'Đã mở bản gốc và phát được, nhưng Audiveris không trả về tọa độ để tô sáng trên ảnh.');
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setRunning(false);
    }
  };

  // tự bắt đầu ngay khi có Audiveris (không bắt người dùng bấm thêm)
  useEffect(() => {
    if (engine?.found && stage === 0 && !running) void run();
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 bg-black/30 grid place-items-center" role="dialog" aria-label="Nhận dạng bản nhạc">
      <div className="w-[520px] rounded-xl border border-line bg-surface shadow-2xl p-5 space-y-4 hm-enter">
        <header>
          <h2 className="font-semibold text-[15px]">Nhận dạng bản nhạc (OMR)</h2>
          <p className="text-muted text-[12px] mt-0.5 truncate">{file.name}</p>
        </header>
        {!invoke && <p className="text-[13px]">Nhận dạng ảnh/PDF cần chạy trong ứng dụng desktop.</p>}
        {invoke && engine && !engine.found && (
          <div className="space-y-2 text-[13px]">
            <p>Không tìm thấy <b>Audiveris</b> đi kèm bộ cài (có thể bộ cài bị hỏng hoặc đang chạy bản dựng thử). Hãy cài lại Holy Melody từ trang tải về.</p>
            <p className="text-[12px] text-muted">Nếu muốn dùng Audiveris cài riêng: tải tại <code className="select-all bg-surface-2 px-1 rounded">{engine.downloadUrl}</code> rồi bấm Kiểm tra lại.</p>
            <button className="h-8 px-3 rounded-md border border-line hover:bg-surface-2" onClick={() => void (invoke('omr_detect') as Promise<typeof engine>).then(setEngine)}>Kiểm tra lại</button>
          </div>
        )}
        {invoke && engine?.found && (
          <>
            <ol className="space-y-1">
              {STEPS.map((s, i) => {
                const n = i + 1;
                const state = n < stage ? 'done' : n === stage && running ? 'active' : n <= stage && !running && !error ? 'done' : 'todo';
                return (
                  <li key={s} className="flex items-center gap-2 text-[12.5px]">
                    <span className={`h-5 w-5 grid place-items-center rounded-full text-[10px] ${state === 'done' ? 'bg-play text-white' : state === 'active' ? 'bg-accent text-accent-fg animate-pulse' : 'bg-surface-2 text-muted'}`}>
                      {state === 'done' ? '✓' : n}
                    </span>
                    <span className={state === 'todo' ? 'text-muted' : ''}>{s}</span>
                  </li>
                );
              })}
            </ol>
            {line && <p className="text-[10.5px] text-muted font-mono truncate">{line}</p>}
            <p className="text-[11px] text-muted">Bản gốc được giữ nguyên để xem; lớp nhận dạng chỉ dùng để phát và tô sáng. Khuông nhạc đầy đủ được dựng khi bạn chọn "Chuyển sang Edit".</p>
          </>
        )}
        {error && <pre className="text-[11px] whitespace-pre-wrap bg-warn/10 text-warn rounded-md p-2 max-h-40 overflow-auto">{error}</pre>}
        <footer className="flex justify-end gap-2">
          <button className="h-9 px-4 rounded-md border border-line hover:bg-surface-2" onClick={onClose} disabled={running}>Đóng</button>
          {invoke && engine?.found && (
            <button className="h-9 px-4 rounded-md bg-accent text-accent-fg font-semibold disabled:opacity-50" onClick={() => void run()} disabled={running}>
              {running ? 'Đang nhận dạng…' : error ? 'Thử lại' : 'Mở bản nhạc'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
