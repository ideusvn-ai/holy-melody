import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useActiveProject, useStore, type MainTab } from './state/store';
import { usePlayback } from './state/playback';
import { exportMidiFile, exportMusicXmlFile, importFile, saveProject } from './lib/fileio';
import { PlayerCenter, PlayerLeft, PlayerRight } from './views/PlayerView';
import { EditorCenter, EditorLeft, EditorRight } from './views/EditorView';
import { SingerCenter } from './views/SingerView';
import { Transport } from './components/Transport';
import {
  IconCoin, IconExport, IconImport, IconLogo, IconMoon, IconNew, IconOpen, IconPanelLeft, IconPanelRight, IconRedo,
  IconSave, IconSearch, IconSettings, IconSun, IconUndo, IconUser, IconX, IconZoomIn, IconZoomOut,
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

  // ---- dự án đầu tiên
  useEffect(() => {
    if (useStore.getState().projects.length === 0) useStore.getState().newProject();
  }, []);

  const openFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
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
    { id: 'new', label: 'Dự án mới', hint: '⌘N', run: () => st.newProject() },
    { id: 'open', label: 'Mở / Import file…', hint: '⌘O', run: () => fileInput.current?.click() },
    { id: 'save', label: 'Lưu dự án', hint: '⌘S', run: () => void save() },
    { id: 'xml', label: 'Export MusicXML', run: () => project && void exportMusicXmlFile(project.score) },
    { id: 'midi', label: 'Export MIDI', run: () => project && void exportMidiFile(project.score) },
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
      if (mod && k === 'n') { e.preventDefault(); st.newProject(); return; }
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
        <button className={ib} title="Mới (⌘N)" onClick={() => st.newProject()}><IconNew /></button>
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
        <div className="flex items-center gap-1.5 px-2 h-8 rounded-md text-muted" title="Số dư credit (cần đăng nhập)">
          <IconCoin /> <span className="tabular-nums text-xs">—</span>
        </div>
        <button
          className="h-8 flex items-center gap-1.5 px-2.5 rounded-md border border-line hover:bg-surface-2"
          onClick={() => st.notify('Đăng nhập Google qua trình duyệt hệ thống (OAuth PKCE) sẽ có ở Phase 6. Các chức năng soạn và phát không cần đăng nhập.')}
        >
          <IconUser /> <span className="text-xs">Đăng nhập</span>
        </button>
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

      {project?.unverified && (
        <div className="px-4 py-1.5 text-[12px] bg-accent-soft border-b border-line">Bản nhạc tạo từ nhận dạng (OMR) còn phần chưa được xác minh — hãy kiểm tra trước khi phát hoặc biên tập.</div>
      )}

      {/* ---------------- main */}
      <main className="flex-1 flex min-h-0">
        {st.layout.leftOpen && left[st.tab] && (
          <Side side="left" width={st.layout.leftWidth} onResize={(w) => st.setLayout({ leftWidth: w })}>{left[st.tab]}</Side>
        )}
        <div className="flex-1 flex flex-col min-w-0" key={st.tab}>{center[st.tab]}</div>
        {st.layout.rightOpen && right[st.tab] && (
          <Side side="right" width={st.layout.rightWidth} onResize={(w) => st.setLayout({ rightWidth: w })}>{right[st.tab]}</Side>
        )}
      </main>

      {st.tab === 'player' && <Transport />}
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
            <div className="text-muted text-xs mt-1">MusicXML · MIDI · dự án Holy Melody</div>
          </div>
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
          <button className={item} onClick={() => { notify('Xuất PDF/PNG/SVG cần renderer Verovio (Phase 2–3).'); setOpen(false); }}>PDF · PNG · SVG <span className="text-muted">(Phase 3)</span></button>
          <button className={item} onClick={() => { notify('Xuất WAV/MP3 cần engine âm thanh Rust (Phase 2).'); setOpen(false); }}>WAV · MP3 <span className="text-muted">(Phase 2)</span></button>
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
