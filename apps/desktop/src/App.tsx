import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useActiveProject, useStore, type MainTab } from './state/store';
import { usePlayback } from './state/playback';
import { detectKind, exportMidiFile, exportMusicXmlFile, importFile, saveProject } from './lib/fileio';
import { openSheet } from './lib/sheet';
import { useOmrProgress } from './state/omrProgress';
import { AccountMenu } from './components/AccountMenu';
import { listRecoverable, markClean, recover, startAutosave, type Recoverable } from './lib/autosave';
import { verifyMeasures } from '@holy-melody/music-core';
import { exportMxlFile, exportPngFile, exportSvgFile, exportWavFile, printScore } from './lib/exporters';
import { PlayerCenter, PlayerLeft, PlayerRight } from './views/PlayerView';
import { EditorCenter, EditorLeft, EditorRight } from './views/EditorView';
import { SingerCenter } from './views/SingerView';
import { Transport } from './components/Transport';
import { Welcome } from './components/Welcome';
import {
  IconExport, IconImport, IconLogo, IconMoon, IconNew, IconOpen, IconPanelLeft, IconPanelRight, IconRedo,
  IconSave, IconSearch, IconSettings, IconSun, IconUndo, IconX, IconZoomIn, IconZoomOut,
} from './components/icons';

const TABS: { id: MainTab; label: string }[] = [
  { id: 'player', label: 'PLAYER' },
  { id: 'editor', label: 'SCORE EDITOR' },
  { id: 'singer', label: 'AI SINGER' },
];

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function App() {
  const st = useStore();
  const project = useActiveProject();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // ---- theme & giảm chuyển động
  useEffect(() => {
    const apply = () => {
      const dark = st.theme === 'dark' || (st.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [st.theme]);
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(st.reducedMotion);
  }, [st.reducedMotion]);

  // ---- tự động lưu, khôi phục sau sự cố (không tạo sẵn bản nhạc: màn hình chào chỉ có Tạo mới / Mở)
  const [recoverable, setRecoverable] = useState<Recoverable[]>([]);
  useEffect(() => {
    void listRecoverable().then(setRecoverable);
    return startAutosave();
  }, []);

  const openFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const kind = detectKind(f.name);
      if (kind === 'image' || kind === 'pdf') {
        openSheetFile(f);
        continue;
      }
      try {
        const r = await importFile(f);
        st.newProject(r.score, f.name);
        for (const w of r.warnings) st.notify(w);
        if (r.score.provenance.source !== 'new') st.notify(`Đã mở ${f.name}`);
      } catch (e) {
        st.notify((e as Error).message, 'error');
      }
    }
  };

  // "Mới" khi đang có dự án: về màn hình chào để chọn mẫu; khi chưa có: đã ở màn hình chào
  const newBlank = () => { st.setActive(''); };

  /** Ảnh/PDF: hiện bản gốc ngay, nhận dạng chạy nền, kết quả về dần theo trang */
  const openSheetFile = (f: File) => {
    let pid: string | undefined;
    let sid = '';
    void openSheet(f, {
      onPlaceholder: (s) => {
        sid = s.id;
        pid = useStore.getState().newProject(s, f.name);
        useStore.getState().setTab('player');
      },
      onUpdate: (s) => pid && useStore.getState().replaceScore(pid, s),
      onProgress: (stage) => stage && sid && useOmrProgress.getState().set(sid, stage),
    })
      .then((s) => st.notify(s.sheet?.measures.length
        ? `Đã nhận dạng xong ${f.name}. Bấm Phát để nghe; nốt đang phát sáng ngay trên bản gốc.`
        : `Đã nhận dạng ${f.name}, nhưng không có tọa độ để tô sáng trên ảnh.`))
      .catch((e) => st.notify(`Không nhận dạng được ${f.name}: ${String((e as Error).message ?? e)}`, 'error'));
  };

  const save = async () => {
    if (!project) return;
    try {
      const path = await saveProject(project.score);
      if (path) st.markSaved(path);
    } catch (e) {
      st.notify(`Không lưu được: ${(e as Error).message}`, 'error');
    }
  };

  const commands: Cmd[] = useMemo(() => [
    { id: 'new', label: 'Dự án mới', hint: '⌘N', run: () => newBlank() },
    { id: 'open', label: 'Mở / Import file…', hint: '⌘O', run: () => fileInput.current?.click() },
    { id: 'save', label: 'Lưu dự án', hint: '⌘S', run: () => void save() },
    { id: 'xml', label: 'Export MusicXML', run: () => project && void exportMusicXmlFile(project.score) },
    { id: 'midi', label: 'Export MIDI', run: () => project && void exportMidiFile(project.score) },
    { id: 'mxl', label: 'Export MXL (MusicXML nén)', run: () => project && void exportMxlFile(project.score) },
    { id: 'pdf', label: 'In / Lưu PDF', hint: '⌘P', run: () => project && void printScore(project.score) },
    { id: 'png', label: 'Export PNG', run: () => project && void exportPngFile(project.score, 0) },
    { id: 'wav', label: 'Export WAV', run: () => project && void exportWavFile(project.score, project.score.playback.mixer).catch((e) => st.notify(String(e.message ?? e), 'error')) },
    { id: 'undo', label: 'Hoàn tác', hint: '⌘Z', run: () => st.undo() },
    { id: 'redo', label: 'Làm lại', hint: '⇧⌘Z', run: () => st.redo() },
    { id: 'play', label: 'Phát / Tạm dừng', hint: 'Space', run: () => usePlayback.getState().toggle() },
    { id: 'tab1', label: 'Chuyển tới Player', hint: '⌘1', run: () => st.setTab('player') },
    { id: 'tab2', label: 'Chuyển tới Score Editor', hint: '⌘2', run: () => st.setTab('editor') },
    { id: 'tab3', label: 'Chuyển tới AI Singer', hint: '⌘3', run: () => st.setTab('singer') },
    { id: 'left', label: 'Ẩn/hiện thanh trái', run: () => st.setLayout({ leftOpen: !st.layout.leftOpen }) },
    { id: 'right', label: 'Ẩn/hiện thanh phải', run: () => st.setLayout({ rightOpen: !st.layout.rightOpen }) },
    { id: 'theme', label: 'Đổi giao diện sáng/tối', run: () => st.setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
    { id: 'motion', label: st.reducedMotion ? 'Bật lại chuyển động' : 'Giảm chuyển động', run: () => st.setReducedMotion(!st.reducedMotion) },
    { id: 'advisor', label: st.advisor.enabled ? 'Tắt Trợ lý soạn nhạc' : 'Bật Trợ lý soạn nhạc', run: () => st.setAdvisorEnabled(!st.advisor.enabled) },
    { id: 'full', label: 'Toàn màn hình', hint: 'F11', run: () => void document.documentElement.requestFullscreen?.() },
  ], [st, project]);

  // ---- phím tắt toàn cục
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = (e.target as HTMLElement).closest('input,textarea,select');
      const k = e.key.toLowerCase();
      if (mod && k === 'k') { e.preventDefault(); st.setPalette(true); return; }
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); st.redo(); return; }
      if (mod && k === 's') { e.preventDefault(); void save(); return; }
      if (mod && k === 'o') { e.preventDefault(); fileInput.current?.click(); return; }
      if (mod && k === 'n') { e.preventDefault(); newBlank(); return; }
      if (mod && k === 'p' && project) { e.preventDefault(); void printScore(project.score); return; }
      if (mod && ['1', '2', '3'].includes(k)) { e.preventDefault(); st.setTab(TABS[Number(k) - 1]!.id); return; }
      if (inField) return;
      if (k === ' ') { e.preventDefault(); usePlayback.getState().toggle(); return; }
      if (k === 'escape') { st.clearSelection(); st.setPalette(false); return; }
      if (k === 'home') { usePlayback.getState().seek(0); return; }
      if (st.tab === 'player' && k === ',') usePlayback.getState().stepMeasure(-1);
      if (st.tab === 'player' && k === '.') usePlayback.getState().stepMeasure(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const dirty = project ? project.score.revision !== project.savedRevision : false;
  const center: Record<MainTab, ReactNode> = { player: <PlayerCenter />, editor: <EditorCenter />, singer: <SingerCenter /> };
  const left: Record<MainTab, ReactNode> = { player: <PlayerLeft />, editor: <EditorLeft />, singer: null };
  const right: Record<MainTab, ReactNode> = { player: <PlayerRight />, editor: <EditorRight />, singer: null };
  const ib = 'h-8 w-8 grid place-items-center rounded-md text-muted hover:text-fg hover:bg-surface-2 active:scale-95 transition disabled:opacity-35';

  return (
    <div
      className="h-full flex flex-col"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); void openFiles(e.dataTransfer.files); }}
    >
      {/* ---------------- top bar */}
      <header className="h-12 flex items-center gap-1 px-2 border-b border-line bg-surface" data-tauri-drag-region>
        <IconLogo size={26} />
        <span className="font-semibold ml-1.5 mr-3 tracking-tight">Holy Melody</span>
        <span className="text-muted truncate max-w-56" title={project?.fileName}>{project?.score.meta.title}{dirty ? ' •' : ''}</span>
        <div className="w-px h-5 bg-line mx-2" />
        <button className={ib} title="Mới (⌘N)" onClick={() => newBlank()}><IconNew /></button>
        <button className={ib} title="Mở (⌘O)" onClick={() => fileInput.current?.click()}><IconOpen /></button>
        <button className={ib} title="Lưu (⌘S)" onClick={() => void save()} disabled={!project}><IconSave /></button>
        <button className={ib} title="Import" onClick={() => fileInput.current?.click()}><IconImport /></button>
        <ExportMenu />
        <div className="w-px h-5 bg-line mx-1" />
        <button className={ib} title={`Hoàn tác ${project?.history.undoLabel() ?? ''} (⌘Z)`} onClick={() => st.undo()} disabled={!project?.history.canUndo()}><IconUndo /></button>
        <button className={ib} title={`Làm lại ${project?.history.redoLabel() ?? ''} (⇧⌘Z)`} onClick={() => st.redo()} disabled={!project?.history.canRedo()}><IconRedo /></button>
        <button className="ml-3 h-8 flex items-center gap-2 px-3 rounded-md bg-surface-2 text-muted hover:text-fg min-w-52" onClick={() => st.setPalette(true)}>
          <IconSearch /> <span className="text-xs">Tìm lệnh…</span><kbd className="ml-auto text-[10px] border border-line rounded px-1">⌘K</kbd>
        </button>
        <div className="flex-1" />
        <button className={ib} title="Thu nhỏ" onClick={() => st.setLayout({ zoom: Math.max(0.5, st.layout.zoom - 0.1) })}><IconZoomOut /></button>
        <span className="text-[11px] text-muted w-9 text-center tabular-nums">{Math.round(st.layout.zoom * 100)}%</span>
        <button className={ib} title="Phóng to" onClick={() => st.setLayout({ zoom: Math.min(2, st.layout.zoom + 0.1) })}><IconZoomIn /></button>
        <button className={ib} title="Thanh trái" onClick={() => st.setLayout({ leftOpen: !st.layout.leftOpen })}><IconPanelLeft /></button>
        <button className={ib} title="Thanh phải" onClick={() => st.setLayout({ rightOpen: !st.layout.rightOpen })}><IconPanelRight /></button>
        <button className={ib} title="Giao diện sáng/tối" onClick={() => st.setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>
          {st.theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
        <button className={ib} title="Cài đặt" onClick={() => st.setPalette(true)}><IconSettings /></button>
        <div className="w-px h-5 bg-line mx-1" />
        <AccountMenu />
      </header>

      {/* ---------------- tabs */}
      <nav className="h-10 flex items-end gap-1 px-3 border-b border-line bg-surface" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={st.tab === t.id}
            className={`relative h-9 px-4 text-[12px] font-semibold tracking-wider transition ${st.tab === t.id ? 'text-fg' : 'text-muted hover:text-fg'}`}
            onClick={() => st.setTab(t.id)}
          >
            {t.label}
            {st.tab === t.id && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-accent rounded-full" />}
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-1 pb-1 overflow-x-auto max-w-[50%]">
          {st.projects.map((p) => (
            <div key={p.id} className={`group flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-md text-[11px] cursor-pointer ${p.id === st.activeId ? 'bg-accent-soft' : 'hover:bg-surface-2 text-muted'}`} onClick={() => st.setActive(p.id)}>
              <span className="truncate max-w-32">{p.score.meta.title}</span>
              <button className="h-5 w-5 grid place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); st.closeProject(p.id); }} aria-label="Đóng dự án"><IconX size={11} /></button>
            </div>
          ))}
        </div>
      </nav>

      {project && project.score.sheet?.mode !== 'overlay' && !project.score.sheet && project.score.provenance.unverifiedEventIds.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-1.5 text-[12px] bg-accent-soft border-b border-line">
          <span>Bản nhạc tạo từ nhận dạng (OMR): còn <b>{project.score.provenance.unverifiedEventIds.length}</b> nốt/dấu lặng chưa xác minh (màu nâu nhạt). Hãy đối chiếu với bản gốc, sửa nếu cần.</span>
          <button className="ml-auto h-7 px-2.5 rounded-md border border-line bg-surface hover:bg-surface-2 disabled:opacity-40" disabled={!st.selection.measureRange}
            onClick={() => st.selection.measureRange && st.exec(verifyMeasures(st.selection.measureRange[0], st.selection.measureRange[1]))}>Xác minh ô đang chọn</button>
          <button className="h-7 px-2.5 rounded-md bg-accent text-accent-fg" onClick={() => st.exec(verifyMeasures(0, project.score.measures.length - 1))}>Xác minh tất cả</button>
        </div>
      )}

      {/* ---------------- main */}
      <main className="flex-1 flex min-h-0">
        {!project ? <Welcome onOpen={() => fileInput.current?.click()} /> : <>
        {st.layout.leftOpen && left[st.tab] && (
          <Side side="left" width={st.layout.leftWidth} onResize={(w) => st.setLayout({ leftWidth: w })}>{left[st.tab]}</Side>
        )}
        <div className="flex-1 flex flex-col min-w-0" key={st.tab}>{center[st.tab]}</div>
        {st.layout.rightOpen && right[st.tab] && (
          <Side side="right" width={st.layout.rightWidth} onResize={(w) => st.setLayout({ rightWidth: w })}>{right[st.tab]}</Side>
        )}
        </>}
      </main>

      {project && st.tab === 'player' && <Transport />}
      <footer className="h-6 flex items-center gap-4 px-3 text-[10.5px] text-muted border-t border-line bg-surface">
        <span>{project ? `${project.score.parts.length} bè · ${project.score.measures.length} ô nhịp` : 'Không có dự án'}</span>
        <span>Offline · không cần đăng nhập để soạn và phát</span>
        <span className="ml-auto">v0.1.0 · Phase 1</span>
      </footer>

      <input ref={fileInput} type="file" multiple hidden accept=".musicxml,.xml,.mxl,.mid,.midi,.holymelody,.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp" onChange={(e) => { if (e.target.files) void openFiles(e.target.files); e.target.value = ''; }} />

      {dragging && (
        <div className="fixed inset-0 z-40 bg-accent/10 backdrop-blur-[2px] grid place-items-center pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center hm-enter">
            <div className="font-semibold">Thả file để mở</div>
            <div className="text-muted text-xs mt-1">PDF · ảnh · MusicXML · MIDI · dự án Holy Melody</div>
          </div>
        </div>
      )}
      {recoverable.length > 0 && (
        <div className="fixed bottom-20 right-6 z-40 w-96 rounded-xl border border-line bg-surface shadow-xl p-4 space-y-2 hm-enter" role="alertdialog" aria-label="Khôi phục bản nhạc">
          <div className="font-semibold">Khôi phục bản nhạc chưa lưu?</div>
          <p className="text-[12px] text-muted">Lần trước Holy Melody đóng đột ngột. Các bản sau được lưu tự động:</p>
          <ul className="text-[12px] space-y-1">
            {recoverable.slice(0, 5).map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className="flex-1 truncate">{r.title}</span>
                <span className="text-muted">{new Date(r.updated_at * 1000).toLocaleString('vi-VN')}</span>
                <button className="h-7 px-2 rounded-md bg-accent text-accent-fg" onClick={() => void recover(r.id).then((s) => { if (s) st.newProject(s, `${s.meta.title}.holymelody`); setRecoverable((x) => x.filter((y) => y.id !== r.id)); })}>Mở</button>
              </li>
            ))}
          </ul>
          <button className="text-[12px] underline text-muted" onClick={() => { for (const r of recoverable) void markClean(r.id); setRecoverable([]); }}>Bỏ qua</button>
        </div>
      )}
      {st.paletteOpen && <Palette commands={commands} onClose={() => st.setPalette(false)} />}
      {st.toast && (
        <div role="status" className={`fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-[12px] hm-enter max-w-xl ${st.toast.kind === 'error' ? 'bg-warn text-white' : 'bg-fg text-bg'}`}>{st.toast.text}</div>
      )}
    </div>
  );
}

function ExportMenu() {
  const project = useActiveProject();
  const [open, setOpen] = useState(false);
  const notify = useStore((s) => s.notify);
  const item = 'w-full text-left px-3 py-1.5 hover:bg-surface-2 disabled:opacity-40';
  return (
    <div className="relative">
      <button className="h-8 w-8 grid place-items-center rounded-md text-muted hover:text-fg hover:bg-surface-2" title="Export" onClick={() => setOpen(!open)} disabled={!project}><IconExport /></button>
      {open && project && (
        <div className="absolute z-30 top-9 left-0 w-56 rounded-lg border border-line bg-surface shadow-lg py-1 hm-enter text-[12px]" onMouseLeave={() => setOpen(false)}>
          <button className={item} onClick={() => { void exportMusicXmlFile(project.score); setOpen(false); }}>MusicXML (.musicxml)</button>
          <button className={item} onClick={() => { void exportMidiFile(project.score); setOpen(false); }}>MIDI (.mid)</button>
          <button className={item} onClick={() => { void exportMxlFile(project.score); setOpen(false); }}>MusicXML nén (.mxl)</button>
          <div className="my-1 border-t border-line" />
          <button className={item} onClick={() => { void printScore(project.score); setOpen(false); }}>In / Lưu PDF… <span className="text-muted">(⌘P)</span></button>
          <button className={item} onClick={() => { void exportSvgFile(project.score, 0).catch((e) => notify(String(e.message ?? e), 'error')); setOpen(false); }}>SVG (trang 1)</button>
          <button className={item} onClick={() => { void exportPngFile(project.score, 0).catch((e) => notify(String(e.message ?? e), 'error')); setOpen(false); }}>PNG 300 dpi (trang 1)</button>
          <div className="my-1 border-t border-line" />
          <button className={item} onClick={() => {
            setOpen(false);
            exportWavFile(project.score, project.score.playback.mixer)
              .then((p) => p && notify(`Đã xuất ${p}`))
              .catch((e) => notify(String(e.message ?? e), 'error'));
          }}>Âm thanh WAV</button>
        </div>
      )}
    </div>
  );
}

function Side({ side, width, onResize, children }: { side: 'left' | 'right'; width: number; onResize: (w: number) => void; children: ReactNode }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!start.current) return;
      const d = e.clientX - start.current.x;
      onResize(Math.max(180, Math.min(520, start.current.w + (side === 'left' ? d : -d))));
    };
    const up = () => (start.current = null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [onResize, side]);
  return (
    <aside className={`relative shrink-0 bg-surface overflow-auto ${side === 'left' ? 'border-r' : 'border-l'} border-line`} style={{ width }}>
      {children}
      <div
        className={`absolute top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/30 ${side === 'left' ? 'right-0' : 'left-0'}`}
        onMouseDown={(e) => (start.current = { x: e.clientX, w: width })}
        role="separator"
        aria-orientation="vertical"
      />
    </aside>
  );
}

function Palette({ commands, onClose }: { commands: Cmd[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const list = commands.filter((c) => norm(c.label).includes(norm(q)));
  const run = (c?: Cmd) => { if (c) { onClose(); c.run(); } };
  return (
    <div className="fixed inset-0 z-50 bg-black/25 grid place-items-start pt-[12vh]" onClick={onClose}>
      <div className="mx-auto w-[520px] rounded-xl border border-line bg-surface shadow-2xl overflow-hidden hm-enter" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 border-b border-line">
          <IconSearch className="text-muted" />
          <input
            autoFocus value={q} placeholder="Gõ để tìm lệnh…"
            className="flex-1 h-11 bg-transparent outline-none"
            onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(list.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(0, i - 1)); }
              if (e.key === 'Enter') run(list[i]);
              if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <ul className="max-h-80 overflow-auto py-1" role="listbox">
          {list.map((c, k) => (
            <li key={c.id} role="option" aria-selected={k === i} className={`flex items-center px-3 py-2 cursor-pointer ${k === i ? 'bg-accent-soft' : ''}`} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
              {c.label}
              {c.hint && <kbd className="ml-auto text-[10px] text-muted">{c.hint}</kbd>}
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-3 text-muted">Không tìm thấy lệnh</li>}
        </ul>
      </div>
    </div>
  );
}
