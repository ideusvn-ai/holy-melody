/**
 * Nhận dạng bản nhạc từ ảnh/PDF bằng Audiveris (cài riêng). Hiển thị 10 bước, tiến trình thật từ Audiveris.
 * Kết quả luôn được đánh dấu "chưa xác minh" để người dùng kiểm tra trước khi phát/biên tập.
 */
import { useEffect, useState } from 'react';
import { importMxl, markAllUnverified } from '@holy-melody/music-core';
import { tauriInvoke } from '../lib/fileio';
import { useStore } from '../state/store';

const STEPS = [
  'Đọc file', 'Phân tích trang', 'Nhận dạng khuông nhạc', 'Nhận dạng khóa nhạc', 'Nhận dạng nốt và dấu hóa',
  'Nhận dạng trường độ và dấu lặng', 'Nhận dạng nhịp và ô nhịp', 'Nhận dạng lời ca', 'Chuyển đổi sang MusicXML', 'Kiểm tra và hiển thị kết quả',
];

type Listen = (event: string, cb: (e: { payload: { stage: number; line: string } }) => void) => Promise<() => void>;

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
    if (!invoke) return;
    setRunning(true);
    setError(null);
    setStage(1);
    let unlisten: (() => void) | undefined;
    try {
      const { listen } = (await import('@tauri-apps/api/event')) as unknown as { listen: Listen };
      unlisten = await listen('omr://progress', (e) => {
        if (e.payload.stage) setStage((s) => Math.max(s, e.payload.stage));
        setLine(e.payload.line.slice(0, 140));
      });
      const path = (await invoke('omr_temp_input', { name: file.name })) as string;
      await invoke('write_file', { path, contents: Array.from(new Uint8Array(await file.arrayBuffer())) });
      const out = (await invoke('omr_run', { input: path })) as { mxlPath: string };
      setStage(10);
      const bytes = new Uint8Array((await invoke('read_file', { path: out.mxlPath })) as number[]);
      const score = await importMxl(bytes);
      if (!score.meta.title || score.meta.title === 'Untitled') score.meta.title = file.name.replace(/\.[^.]+$/, '');
      markAllUnverified(score);
      st.newProject(score, file.name);
      st.setTab('editor');
      st.notify('Đã nhận dạng xong. Các nốt màu nâu nhạt là chưa xác minh — hãy kiểm tra từng ô rồi bấm "Xác minh".');
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      unlisten?.();
      setRunning(false);
    }
  };

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
            <p>Holy Melody dùng <b>Audiveris</b> (miễn phí, mã nguồn mở) để đọc bản nhạc từ ảnh và PDF quét. Audiveris được cài riêng vì dùng giấy phép AGPL.</p>
            <ol className="list-decimal pl-5 space-y-1 text-[12px]">
              <li>Tải bản cài cho máy bạn tại <code className="select-all bg-surface-2 px-1 rounded">{engine.downloadUrl}</code></li>
              <li>Cài đặt như ứng dụng bình thường (giữ thư mục mặc định).</li>
              <li>Quay lại đây và bấm <b>Kiểm tra lại</b>.</li>
            </ol>
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
            <p className="text-[11px] text-muted">Kết quả nhận dạng không thể chính xác 100%: các nốt sẽ được đánh dấu chưa xác minh để bạn kiểm tra và sửa trước khi phát.</p>
          </>
        )}
        {error && <pre className="text-[11px] whitespace-pre-wrap bg-warn/10 text-warn rounded-md p-2 max-h-40 overflow-auto">{error}</pre>}
        <footer className="flex justify-end gap-2">
          <button className="h-9 px-4 rounded-md border border-line hover:bg-surface-2" onClick={onClose} disabled={running}>Đóng</button>
          {invoke && engine?.found && (
            <button className="h-9 px-4 rounded-md bg-accent text-accent-fg font-semibold disabled:opacity-50" onClick={() => void run()} disabled={running}>
              {running ? 'Đang nhận dạng…' : error ? 'Thử lại' : 'Bắt đầu nhận dạng'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
