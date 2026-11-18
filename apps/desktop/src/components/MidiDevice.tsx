/** Chọn bàn phím MIDI (nhập nốt từng bước trong Editor) */
import { useEffect } from 'react';
import { useMidiInput } from '../lib/midiInput';
import { useStore } from '../state/store';

export function MidiDevice() {
  const midi = useMidiInput();
  const notify = useStore((s) => s.notify);
  useEffect(() => {
    void midi.refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-1.5">
      <h3 className="text-[11px] uppercase tracking-wide text-muted">Bàn phím MIDI</h3>
      {midi.connected ? (
        <div className="flex items-center gap-2 text-[12px]"><span className="h-2 w-2 rounded-full bg-play" /> <span className="flex-1 truncate">{midi.connected}</span><button className="text-[11px] underline" onClick={() => void midi.disconnect()}>Ngắt</button></div>
      ) : (
        <div className="flex gap-1.5">
          <select className="flex-1 h-8 rounded-md border border-line bg-surface px-1.5 text-[12px]" defaultValue="" onChange={(e) => e.target.value !== '' && void midi.connect(Number(e.target.value)).catch((x) => notify(String(x.message ?? x), 'error'))}>
            <option value="" disabled>{midi.ports.length ? 'Chọn thiết bị…' : 'Không thấy thiết bị'}</option>
            {midi.ports.map((n, i) => <option key={n + i} value={i}>{n}</option>)}
          </select>
          <button className="h-8 px-2 rounded-md border border-line text-[12px]" onClick={() => void midi.refresh()} title="Tìm lại">↻</button>
        </div>
      )}
    </div>
  );
}
