/**
 * MXL (MusicXML nén) – file ZIP chứa META-INF/container.xml trỏ tới file .musicxml chính.
 * Dùng CompressionStream/DecompressionStream('deflate-raw') có sẵn trong WebView (WebKit, WebView2) và Node ≥ 18,
 * nên không cần thư viện zip.
 */
import { exportMusicXml, importMusicXml, MusicXmlError } from './musicxml.js';
import type { ScoreDocument } from './model.js';
import { child, kids, parseXml } from './xml.js';

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  crc: number;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

function readEntries(b: Uint8Array): ZipEntry[] {
  // tìm End Of Central Directory (có thể có comment phía sau)
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new MusicXmlError('File MXL hỏng: không tìm thấy mục lục ZIP');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(b, p) !== 0x02014b50) throw new MusicXmlError('File MXL hỏng: mục lục ZIP sai');
    const method = u16(b, p + 10);
    const crc = u32(b, p + 16);
    const compressedSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    out.push({ name: dec.decode(b.subarray(p + 46, p + 46 + nameLen)), method, compressedSize, size, offset, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function streamThrough(data: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

async function extract(b: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  if (u32(b, e.offset) !== 0x04034b50) throw new MusicXmlError(`File MXL hỏng: ${e.name}`);
  const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
  const raw = b.subarray(start, start + e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return streamThrough(raw, new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
  throw new MusicXmlError(`Kiểu nén ZIP chưa hỗ trợ (${e.method})`);
}

/** Đọc MXL → chuỗi MusicXML của bản nhạc chính */
export async function readMxl(bytes: Uint8Array): Promise<string> {
  const entries = readEntries(bytes);
  const dec = new TextDecoder();
  let rootPath: string | undefined;
  const container = entries.find((e) => e.name === 'META-INF/container.xml');
  if (container) {
    const xml = parseXml(dec.decode(await extract(bytes, container)));
    rootPath = kids(child(xml, 'rootfiles'), 'rootfile').find((r) => !r.attrs['media-type'] || r.attrs['media-type'].includes('musicxml'))?.attrs['full-path'];
  }
  const entry = (rootPath && entries.find((e) => e.name === rootPath))
    ?? entries.find((e) => /\.(musicxml|xml)$/i.test(e.name) && !e.name.startsWith('META-INF/'));
  if (!entry) throw new MusicXmlError('File MXL không chứa bản nhạc MusicXML');
  return dec.decode(await extract(bytes, entry));
}

export async function importMxl(bytes: Uint8Array): Promise<ScoreDocument> {
  return importMusicXml(await readMxl(bytes));
}

// ---------------------------------------------------------------- ghi

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Tạo ZIP (mimetype không nén, đứng đầu – theo đặc tả MusicXML) */
export async function writeZip(files: { name: string; data: Uint8Array; store?: boolean }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const le16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const body = f.store ? f.data : await streamThrough(f.data, new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
    const method = f.store ? 0 : 8;
    const local = new Uint8Array([
      ...le32(0x04034b50), ...le16(20), ...le16(0x0800), ...le16(method), ...le16(0), ...le16(0x21),
      ...le32(crc), ...le32(body.length), ...le32(f.data.length), ...le16(name.length), ...le16(0), ...name,
    ]);
    chunks.push(local, body);
    central.push(new Uint8Array([
      ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0x0800), ...le16(method), ...le16(0), ...le16(0x21),
      ...le32(crc), ...le32(body.length), ...le32(f.data.length), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(0), ...le32(offset), ...name,
    ]));
    offset += local.length + body.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length), ...le32(cdSize), ...le32(offset), ...le16(0)]);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export async function exportMxl(score: ScoreDocument): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>
`;
  return writeZip([
    { name: 'mimetype', data: enc.encode('application/vnd.recordare.musicxml'), store: true },
    { name: 'META-INF/container.xml', data: enc.encode(container) },
    { name: 'score.musicxml', data: enc.encode(exportMusicXml(score)) },
  ]);
}
