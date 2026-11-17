/**
 * Mở / lưu / xuất file. Trong Tauri dùng hộp thoại hệ thống + lệnh Rust ghi file;
 * ngoài Tauri (chạy thử trên trình duyệt) dùng tải xuống Blob.
 */
import { exportMidi, exportMusicXml, importMidi, importMusicXml, importMxl, type ScoreDocument } from '@holy-melody/music-core';

export type ImportKind = 'musicxml' | 'mxl' | 'midi' | 'project' | 'image' | 'pdf' | 'unknown';

export function detectKind(name: string): ImportKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['musicxml', 'xml'].includes(ext)) return 'musicxml';
  if (ext === 'mxl') return 'mxl';
  if (['mid', 'midi'].includes(ext)) return 'midi';
  if (ext === 'holymelody' || ext === 'json') return 'project';
  if (['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'unknown';
}

export interface ImportOutcome {
  score: ScoreDocument;
  warnings: string[];
}

export class ImportNotSupportedError extends Error {}

export async function importFile(file: File): Promise<ImportOutcome> {
  const kind = detectKind(file.name);
  switch (kind) {
    case 'musicxml':
      return { score: importMusicXml(await file.text()), warnings: [] };
    case 'midi': {
      const r = importMidi(new Uint8Array(await file.arrayBuffer()), { title: file.name.replace(/\.[^.]+$/, '') });
      return r;
    }
    case 'project': {
      const s = JSON.parse(await file.text()) as ScoreDocument;
      if (s.schemaVersion !== 1 || !Array.isArray(s.parts)) throw new Error('File dự án không hợp lệ');
      return { score: s, warnings: [] };
    }
    case 'mxl':
      return { score: await importMxl(new Uint8Array(await file.arrayBuffer())), warnings: [] };
    case 'image':
    case 'pdf':
      throw new ImportNotSupportedError('Nhận dạng bản nhạc từ ảnh/PDF (OMR) thuộc Phase 4 và chưa được tích hợp trong bản này.');
    default:
      throw new ImportNotSupportedError(`Định dạng chưa hỗ trợ: ${file.name}`);
  }
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
export const tauriInvoke = (): Invoke | undefined =>
  (globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;

export async function saveBytes(defaultName: string, bytes: Uint8Array, mime: string, filters: { name: string; extensions: string[] }[]): Promise<string | undefined> {
  const invoke = tauriInvoke();
  if (invoke) {
    const path = (await invoke('plugin:dialog|save', { options: { defaultPath: defaultName, filters } })) as string | null;
    if (!path) return undefined;
    await invoke('write_file', { path, contents: Array.from(bytes) });
    return path;
  }
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return defaultName;
}

const base = (s: ScoreDocument) => (s.meta.title || 'score').replace(/[\\/:*?"<>|]+/g, '_');

export const saveProject = (s: ScoreDocument) =>
  saveBytes(`${base(s)}.holymelody`, new TextEncoder().encode(JSON.stringify(s)), 'application/json', [{ name: 'Holy Melody', extensions: ['holymelody'] }]);

export const exportMusicXmlFile = (s: ScoreDocument) =>
  saveBytes(`${base(s)}.musicxml`, new TextEncoder().encode(exportMusicXml(s)), 'application/vnd.recordare.musicxml+xml', [{ name: 'MusicXML', extensions: ['musicxml', 'xml'] }]);

export const exportMidiFile = (s: ScoreDocument) =>
  saveBytes(`${base(s)}.mid`, exportMidi(s), 'audio/midi', [{ name: 'MIDI', extensions: ['mid'] }]);
