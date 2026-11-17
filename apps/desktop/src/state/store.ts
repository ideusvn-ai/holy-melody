/**
 * Store dùng chung của ba tab. Chỉ có MỘT ScoreDocument cho mỗi dự án; Player, Editor, AI Singer
 * đều đọc từ đây, mọi chỉnh sửa đi qua CommandHistory → revision tăng → các view tự cập nhật.
 */
import { create } from 'zustand';
import {
  analyzeComposition, buildTimeline, CommandHistory, createScore, dismissSuggestion, restoreDismissed, setRuleEnabled,
  type AdvisorRule, type AdvisorSuggestion, type ChordSymbol, type Command, type PlaybackTimeline, type ScoreDocument,
} from '@holy-melody/music-core';

export type MainTab = 'player' | 'editor' | 'singer';
export type Theme = 'light' | 'dark' | 'system';

export interface Project {
  id: string;
  score: ScoreDocument;
  history: CommandHistory;
  filePath?: string;
  fileName: string;
  savedRevision: number;
  /** Dự án tạo từ OMR: phần chưa xác minh */
  unverified: boolean;
}

export interface Selection {
  noteIds: string[];
  eventIds: string[];
  /** [from, to] chỉ số ô nhịp */
  measureRange?: [number, number];
  partIds?: string[];
}

interface LayoutPrefs {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  zoom: number;
}

interface State {
  projects: Project[];
  activeId: string | null;
  tab: MainTab;
  selection: Selection;
  /** tăng mỗi khi score đổi, để component đăng ký render lại */
  revision: number;
  timeline: PlaybackTimeline | null;
  advisor: { enabled: boolean; suggestions: AdvisorSuggestion[]; hymnMode: boolean };
  theme: Theme;
  reducedMotion: boolean;
  layout: LayoutPrefs;
  paletteOpen: boolean;
  toast: { id: number; text: string; kind: 'info' | 'error' } | null;
  /** Hợp âm đang xem trước (chưa áp dụng) */
  harmonyPreview: ChordSymbol[] | null;
  setHarmonyPreview(c: ChordSymbol[] | null): void;

  newProject(score?: ScoreDocument, fileName?: string): void;
  closeProject(id: string): void;
  setActive(id: string): void;
  setTab(tab: MainTab): void;
  exec(cmd: Command): void;
  undo(): void;
  redo(): void;
  select(sel: Partial<Selection>): void;
  clearSelection(): void;
  markSaved(path?: string, name?: string): void;
  dismissSuggestion(id: string): void;
  setRule(rule: AdvisorRule, on: boolean): void;
  restoreSuggestions(): void;
  setAdvisorEnabled(on: boolean): void;
  setHymnMode(on: boolean): void;
  setTheme(t: Theme): void;
  setReducedMotion(on: boolean): void;
  setLayout(p: Partial<LayoutPrefs>): void;
  setPalette(open: boolean): void;
  notify(text: string, kind?: 'info' | 'error'): void;
}

const PREFS_KEY = 'holy-melody:prefs';
function loadPrefs(): Partial<Pick<State, 'theme' | 'reducedMotion' | 'layout'>> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function savePrefs(s: Pick<State, 'theme' | 'reducedMotion' | 'layout'>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: s.theme, reducedMotion: s.reducedMotion, layout: s.layout }));
  } catch {
    /* storage không khả dụng: bỏ qua */
  }
}

let advisorTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => {
  const prefs = loadPrefs();

  /** Gọi sau mọi thay đổi score: dựng lại timeline, lên lịch phân tích gợi ý (không chặn UI) */
  const refresh = () => {
    const p = active();
    if (!p) {
      set({ timeline: null, advisor: { ...get().advisor, suggestions: [] } });
      return;
    }
    set({ revision: p.score.revision, timeline: buildTimeline(p.score) });
    if (advisorTimer) clearTimeout(advisorTimer);
    advisorTimer = setTimeout(() => {
      const cur = active();
      if (!cur || !get().advisor.enabled) return;
      const suggestions = analyzeComposition(cur.score, { hymnMode: get().advisor.hymnMode });
      set({ advisor: { ...get().advisor, suggestions } });
    }, 250);
  };
  const active = () => get().projects.find((p) => p.id === get().activeId);

  return {
    projects: [],
    activeId: null,
    tab: 'player',
    selection: { noteIds: [], eventIds: [] },
    revision: 0,
    timeline: null,
    advisor: { enabled: true, suggestions: [], hymnMode: true },
    theme: prefs.theme ?? 'system',
    reducedMotion: prefs.reducedMotion ?? false,
    layout: { leftOpen: true, rightOpen: true, leftWidth: 240, rightWidth: 320, zoom: 1, ...prefs.layout },
    paletteOpen: false,
    toast: null,
    harmonyPreview: null,
    setHarmonyPreview(harmonyPreview) {
      set({ harmonyPreview });
    },

    newProject(score, fileName) {
      const s = score ?? createScore({ title: 'Bài mới', measures: 8, parts: [{ name: 'Giai điệu' }] });
      const id = crypto.randomUUID();
      const history = new CommandHistory(s);
      const project: Project = {
        id, score: s, history, fileName: fileName ?? `${s.meta.title}.holymelody`,
        savedRevision: s.revision, unverified: s.provenance.source === 'omr' && s.provenance.unverifiedEventIds.length > 0,
      };
      history.onChange(() => {
        if (get().activeId === id) refresh();
      });
      set({ projects: [...get().projects, project], activeId: id, selection: { noteIds: [], eventIds: [] } });
      refresh();
    },
    closeProject(id) {
      const closing = get().projects.find((p) => p.id === id);
      if (closing) void import('../lib/autosave').then((m) => m.markClean(closing.score.id));
      const projects = get().projects.filter((p) => p.id !== id);
      set({ projects, activeId: get().activeId === id ? (projects[projects.length - 1]?.id ?? null) : get().activeId });
      refresh();
    },
    setActive(id) {
      set({ activeId: id, selection: { noteIds: [], eventIds: [] } });
      refresh();
    },
    setTab(tab) {
      // Không sao chép dữ liệu khi chuyển tab: giữ nguyên selection và vị trí
      set({ tab });
    },
    exec(cmd) {
      const p = active();
      if (!p) return;
      try {
        p.history.execute(cmd);
      } catch (e) {
        get().notify((e as Error).message, 'error');
      }
    },
    undo() {
      active()?.history.undo();
    },
    redo() {
      active()?.history.redo();
    },
    select(sel) {
      set({ selection: { ...get().selection, ...sel } });
    },
    clearSelection() {
      set({ selection: { noteIds: [], eventIds: [] } });
    },
    markSaved(path, name) {
      const p = active();
      if (!p) return;
      void import('../lib/autosave').then((m) => m.markClean(p.score.id));
      set({
        projects: get().projects.map((x) => (x.id === p.id ? { ...x, savedRevision: p.score.revision, filePath: path ?? x.filePath, fileName: name ?? x.fileName } : x)),
      });
    },
    dismissSuggestion(id) {
      const p = active();
      if (!p) return;
      dismissSuggestion(p.score, id);
      set({ advisor: { ...get().advisor, suggestions: get().advisor.suggestions.filter((s) => s.id !== id) } });
    },
    setRule(rule, on) {
      const p = active();
      if (!p) return;
      setRuleEnabled(p.score, rule, on);
      refresh();
    },
    restoreSuggestions() {
      const p = active();
      if (!p) return;
      restoreDismissed(p.score);
      if (p.score.advisor) p.score.advisor.disabledRules = [];
      refresh();
    },
    setAdvisorEnabled(on) {
      set({ advisor: { ...get().advisor, enabled: on, suggestions: on ? get().advisor.suggestions : [] } });
      if (on) refresh();
    },
    setHymnMode(on) {
      set({ advisor: { ...get().advisor, hymnMode: on } });
      refresh();
    },
    setTheme(theme) {
      set({ theme });
      savePrefs(get());
    },
    setReducedMotion(reducedMotion) {
      set({ reducedMotion });
      savePrefs(get());
    },
    setLayout(p) {
      set({ layout: { ...get().layout, ...p } });
      savePrefs(get());
    },
    setPalette(paletteOpen) {
      set({ paletteOpen });
    },
    notify(text, kind = 'info') {
      const id = Date.now();
      set({ toast: { id, text, kind } });
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, 3500);
    },
  };
});

export const useActiveProject = () => useStore((s) => s.projects.find((p) => p.id === s.activeId));
