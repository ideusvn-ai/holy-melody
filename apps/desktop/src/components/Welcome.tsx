/** Màn hình khi chưa mở bản nhạc nào: chỉ "Tạo mới" hoặc "Mở bản nhạc" — không tạo sẵn score */
import { useState } from 'react';
import { createInstrument, createScore, type NewScoreOptions } from '@holy-melody/music-core';
import { useStore } from '../state/store';
import { IconLogo, IconNew, IconOpen } from './icons';

const TEMPLATES: { id: string; label: string; hint: string; opts: NewScoreOptions }[] = [
  { id: 'melody', label: 'Giai điệu', hint: '1 khuông, khoá Sol', opts: { parts: [{ name: 'Giai điệu' }] } },
  {
    id: 'satb', label: 'Hợp xướng SATB', hint: '4 bè, 2 khuông',
    opts: {
      parts: [
        { name: 'Soprano · Alto', instrument: createInstrument('Choir Aahs', 52, 0) },
        { name: 'Tenor · Bass', instrument: createInstrument('Choir Aahs', 52, 1), clefs: [{ sign: 'F', line: 4 }] },
      ],
    },
  },
  { id: 'piano', label: 'Piano', hint: 'khoá Sol + khoá Fa', opts: { parts: [{ name: 'Piano', clefs: [{ sign: 'G', line: 2 }, { sign: 'F', line: 4 }] }] } },
];

export function Welcome({ onOpen }: { onOpen: () => void }) {
  const newProject = useStore((s) => s.newProject);
  const setTab = useStore((s) => s.setTab);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [tpl, setTpl] = useState('melody');
  const [time, setTime] = useState('4/4');

  const create = () => {
    const t = TEMPLATES.find((x) => x.id === tpl)!;
    const [beats, beatType] = time.split('/').map(Number);
    newProject(createScore({ ...t.opts, title: title.trim() || 'Bài mới', measures: 8, beats, beatType }), `${title.trim() || 'Bài mới'}.holymelody`);
    setTab('editor');
  };

  const card = 'flex-1 rounded-2xl border border-line bg-surface p-6 text-left hover:border-accent hover:shadow-md transition';
  return (
    <div className="flex-1 grid place-items-center bg-surface-2 p-8 overflow-auto">
      <div className="w-full max-w-2xl space-y-6 hm-enter">
        <div className="flex items-center gap-3">
          <IconLogo size={40} />
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">Holy Melody</h1>
            <p className="text-muted text-[13px]">Mở bản nhạc để nghe, hoặc soạn bài mới.</p>
          </div>
        </div>
        {!creating ? (
          <div className="flex gap-4">
            <button className={card} onClick={() => setCreating(true)} autoFocus>
              <IconNew size={22} />
              <div className="mt-3 font-semibold text-[15px]">Tạo mới</div>
              <div className="text-muted text-[12px] mt-1">Soạn một bản nhạc trống trong Score Editor</div>
            </button>
            <button className={card} onClick={onOpen}>
              <IconOpen size={22} />
              <div className="mt-3 font-semibold text-[15px]">Mở bản nhạc</div>
              <div className="text-muted text-[12px] mt-1">PDF, ảnh chụp/quét, MusicXML, MXL, MIDI, dự án .holymelody</div>
            </button>
          </div>
        ) : (
          <form className="rounded-2xl border border-line bg-surface p-5 space-y-4" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <label className="block text-[12px] text-muted">Tên bài
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bài mới" className="mt-1 w-full h-9 rounded-md border border-line bg-surface px-2.5 text-[14px] text-fg" />
            </label>
            <div className="text-[12px] text-muted">Mẫu
              <div className="mt-1 grid grid-cols-3 gap-2">
                {TEMPLATES.map((t) => (
                  <button type="button" key={t.id} onClick={() => setTpl(t.id)} aria-pressed={tpl === t.id}
                    className={`rounded-lg border p-2.5 text-left ${tpl === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}>
                    <div className="text-fg font-medium text-[13px]">{t.label}</div>
                    <div className="text-[11px]">{t.hint}</div>
                  </button>
                ))}
              </div>
            </div>
            <label className="block text-[12px] text-muted">Số chỉ nhịp
              <select value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 block h-9 rounded-md border border-line bg-surface px-2 text-fg">
                {['4/4', '3/4', '2/4', '6/8', '3/8', '2/2'].map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="h-9 px-4 rounded-md border border-line hover:bg-surface-2" onClick={() => setCreating(false)}>Quay lại</button>
              <button type="submit" className="h-9 px-4 rounded-md bg-accent text-accent-fg font-semibold">Tạo bản nhạc</button>
            </div>
          </form>
        )}
        <p className="text-[11.5px] text-muted text-center">Hoặc kéo thả file vào cửa sổ này.</p>
      </div>
    </div>
  );
}
