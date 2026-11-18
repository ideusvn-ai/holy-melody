/**
 * Store dùng chung của ba tab. Chỉ có MỘT ScoreDocument cho mỗi dự án; Player, Editor, AI Singer
 * đều đọc từ đây, mọi chỉnh sửa đi qua CommandHistory → revision tăng → các view tự cập nhật.
 */
import { create } from 'zustand';
import {
  accompany, analyzeComposition, buildTimeline, chordsForAccompaniment, CommandHistory, DEFAULT_PLAYER_SETTINGS, type PlayerSettings, createScore, dismissSuggestion, restoreDismissed, setRuleEnabled,
  type AdvisorRule, type AdvisorSuggestion, type ChordSymbol, type Command, type Duration, type PlaybackTimeline, type ScoreDocument,
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
  /** Editor: bấm lên khuông để đặt nốt (chế độ nhập nốt) và trường độ đang chọn */
  noteInput: boolean;
  inputDuration: Duration;
  setNoteInput(on: boolean): void;
  setInputDuration(d: Duration): void;
  /** Cài đặt phát của Player (nhạc cụ, âm lượng, đệm hợp âm, dịch giọng, dạo đầu, đếm vào) */
  player: PlayerSettings;
  setPlayer(patch: Partial<PlayerSettings>): void;
  reducedMotion: boolean;
  layout: LayoutPrefs;
  paletteOpen: boolean;
  toast: { id: number; text: string; kind: 'info' | 'error' } | null;
  /** Hợp âm đang xem trước (chưa áp dụng) */
  harmonyPreview: ChordSymbol[] | null;
  setHarmonyPreview(c: ChordSymbol[] | null): void;

  newProject(score?: ScoreDocument, fileName?: string): string;
  /** Thay toàn bộ bản nhạc của một dự án (kết quả nhận dạng về dần theo trang); lịch sử Undo bắt đầu lại */
  replaceScore(projectId: string, score: ScoreDocument): void;
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
function loadPrefs(): Partial<Pick<State, 'theme' | 'reducedMotion' | 'layout' | 'player'>> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function savePrefs(s: Pick<State, 'theme' | 'reducedMotion' | 'layout' | 'player'>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: s.theme, themeChosen: true, reducedMotion: s.reducedMotion, layout: s.layout, player: s.player }));
  } catch {
    /* storage không khả dụng: bỏ qua */
  }
}

let advisorTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => {
  const prefs = loadPrefs();

  /** Gọi sau mọi thay đổi score: dựng lại timeline, lên lịch phân tích gợi ý (không chặn UI) */
  let playerTimer: ReturnType<typeof setTimeout> | undefined;
  const chordCache = new WeakMap<ScoreDocument, { rev: number; list: ChordSymbol[] }>();
  const refresh = () => {
    const p = active();
    if (!p) {
      set({ timeline: null, advisor: { ...get().advisor, suggestions: [] } });
      return;
    }
    const base = buildTimeline(p.score);
    // Player: đệm hợp âm + dạo đầu + đếm vào + nhạc cụ/âm lượng/dịch giọng (không sửa bản nhạc). Editor: phát trơn.
    let timeline = base;
    if (get().tab === 'player') {
      let chords = chordCache.get(p.score);
      if (!chords || chords.rev !== p.score.revision) {
        chords = { rev: p.score.revision, list: chordsForAccompaniment(p.score) };
        chordCache.set(p.score, chords);
      }
      timeline = accompany(p.score, base, get().player, chords.list);
    }
    set({ revision: p.score.revision, timeline });
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
    // mặc định giao diện sáng; chỉ theo lựa chọn đã lưu khi người dùng tự chọn (bản cũ lưu 'system' tự động)
    theme: (prefs as { themeChosen?: boolean }).themeChosen && prefs.theme ? prefs.theme : 'light',
    noteInput: true,
    inputDuration: { type: 'quarter', dots: 0 },
    setNoteInput(noteInput) {
      set({ noteInput });
    },
    setInputDuration(inputDuration) {
      set({ inputDuration });
    },
    player: { ...DEFAULT_PLAYER_SETTINGS, ...(prefs.player ?? {}) },
    setPlayer(patch) {
      set({ player: { ...get().player, ...patch } });
      savePrefs(get());
      // dựng lại timeline (gộp các lần kéo thanh trượt liên tiếp)
      if (playerTimer) clearTimeout(playerTimer);
      playerTimer = setTimeout(refresh, 120);
    },
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
      return id;
    },
    replaceScore(projectId, score) {
      const old = get().projects.find((p) => p.id === projectId);
      if (!old) return;
      const history = new CommandHistory(score);
      history.onChange(() => {
        if (get().activeId === projectId) refresh();
      });
      set({ projects: get().projects.map((p) => (p.id === projectId ? { ...p, score, history, savedRevision: score.revision } : p)) });
      if (get().activeId === projectId) refresh();
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
      // Không sao chép dữ liệu khi chuyển tab: giữ nguyên selection; timeline đổi (Player có đệm + mở đầu)
      if (tab === get().tab) return;
      set({ tab });
      refresh();
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
