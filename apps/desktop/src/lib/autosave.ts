/**
 * Tự động lưu (SQLite cục bộ qua Rust) mỗi 15 giây khi có thay đổi, giữ 50 phiên bản gần nhất,
 * và khôi phục bản nhạc chưa lưu nếu lần trước ứng dụng bị tắt đột ngột.
 */
import type { ScoreDocument } from '@holy-melody/music-core';
import { useStore } from '../state/store';
import { tauriInvoke } from './fileio';

const saved = new Map<string, number>(); // project id → revision đã autosave

export function startAutosave(): () => void {
  const invoke = tauriInvoke();
  if (!invoke) return () => {};
  const tick = async () => {
    for (const p of useStore.getState().projects) {
      if (saved.get(p.score.id) === p.score.revision) continue;
      try {
        await invoke('project_autosave', {
          id: p.score.id, title: p.score.meta.title, filePath: p.filePath ?? null, revision: p.score.revision, scoreJson: JSON.stringify(p.score),
        });
        saved.set(p.score.id, p.score.revision);
      } catch (e) {
        console.error('[autosave]', e);
      }
    }
  };
  const t = setInterval(() => void tick(), 15_000);
  // đóng cửa sổ bình thường → đánh dấu sạch, không đề nghị khôi phục lần sau
  const onUnload = () => {
    for (const p of useStore.getState().projects) {
      if (p.score.revision === p.savedRevision) void invoke('project_mark_clean', { id: p.score.id });
    }
  };
  window.addEventListener('beforeunload', onUnload);
  return () => {
    clearInterval(t);
    window.removeEventListener('beforeunload', onUnload);
  };
}

export async function markClean(scoreId: string) {
  await tauriInvoke()?.('project_mark_clean', { id: scoreId }).catch(() => {});
}

export interface Recoverable {
  id: string;
  title: string;
  updated_at: number;
}

export async function listRecoverable(): Promise<Recoverable[]> {
  const invoke = tauriInvoke();
  if (!invoke) return [];
  return ((await invoke('project_recover_list').catch(() => [])) as Recoverable[]) ?? [];
}

export async function recover(id: string): Promise<ScoreDocument | null> {
  const json = (await tauriInvoke()?.('project_latest', { id })) as string | null;
  if (!json) return null;
  await markClean(id);
  return JSON.parse(json) as ScoreDocument;
}
