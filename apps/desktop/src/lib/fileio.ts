/**
 * Mở / lưu / xuất file. Trong Tauri dùng hộp thoại hệ thống + lệnh Rust ghi file;
 * ngoài Tauri (chạy thử trên trình duyệt) dùng tải xuống Blob.
 */
import { exportMidi, exportMusicXml, importMidi, importMusicXml, importMxl, isZip, readZip, writeZip, type ScoreDocument } from '@holy-melody/music-core';
import { getSheetAsset, setSheetAsset } from './sheet';

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
      const bytes = new Uint8Array(await file.arrayBuffer());
      const warnings: string[] = [];
      let s: ScoreDocument;
      if (isZip(bytes)) {
        // gói dự án: project.json + file ảnh/PDF gốc (bản nhạc mở từ ảnh/PDF)
        const files = await readZip(bytes);
        const json = files.get('project.json');
        if (!json) throw new Error('File dự án không hợp lệ (thiếu project.json)');
        s = JSON.parse(new TextDecoder().decode(json)) as ScoreDocument;
        const src = s.sheet && files.get(s.sheet.pages[0]?.file ?? '');
        if (s.sheet && src) {
          setSheetAsset(s.id, { kind: s.sheet.kind, bytes: src, mime: s.sheet.kind === 'pdf' ? 'application/pdf' : mimeOf(s.sheet.fileName) });
        } else if (s.sheet) warnings.push('Không tìm thấy file ảnh/PDF gốc trong dự án.');
      } else {
        s = JSON.parse(new TextDecoder().decode(bytes)) as ScoreDocument;
      }
      if (s.schemaVersion !== 1 || !Array.isArray(s.parts)) throw new Error('File dự án không hợp lệ');
      return { score: s, warnings };
    }
    case 'mxl':
      return { score: await importMxl(new Uint8Array(await file.arrayBuffer())), warnings: [] };
    case 'image':
    case 'pdf':
      throw new ImportNotSupportedError('Ảnh/PDF được mở qua trình nhận dạng (Audiveris).');
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

const mimeOf = (name: string) =>
  ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' } as Record<string, string>)[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Nội dung file .holymelody: JSON thuần, hoặc gói zip kèm file gốc khi bản nhạc mở từ ảnh/PDF */
export async function projectBytes(s: ScoreDocument): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  const asset = s.sheet && getSheetAsset(s.id);
  if (!s.sheet || !asset) return json;
  return writeZip([
    { name: 'project.json', data: json },
    { name: s.sheet.pages[0]?.file ?? 'source.bin', data: asset.bytes, store: true },
  ]);
}

export const saveProject = async (s: ScoreDocument) =>
  saveBytes(`${base(s)}.holymelody`, await projectBytes(s), 'application/octet-stream', [{ name: 'Holy Melody', extensions: ['holymelody'] }]);

export const exportMusicXmlFile = (s: ScoreDocument) =>
  saveBytes(`${base(s)}.musicxml`, new TextEncoder().encode(exportMusicXml(s)), 'application/vnd.recordare.musicxml+xml', [{ name: 'MusicXML', extensions: ['musicxml', 'xml'] }]);

export const exportMidiFile = (s: ScoreDocument) =>
  saveBytes(`${base(s)}.mid`, exportMidi(s), 'audio/midi', [{ name: 'MIDI', extensions: ['mid'] }]);
