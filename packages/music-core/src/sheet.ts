/**
 * Lớp phủ trên ảnh gốc: đọc tọa độ trang/hệ thống/ô nhịp/nốt mà Audiveris ghi trong MusicXML
 * (page-layout, system-layout, staff-layout, measure@width, note@default-x) rồi đổi sang tỉ lệ 0..1 của trang.
 * Audiveris tính "tenths" trực tiếp từ ảnh quét (theo khoảng cách dòng kẻ), nên page-width/height tương ứng
 * đúng toàn bộ ảnh: x_ảnh = x_tenths / page-width. Không phụ thuộc độ phân giải hiển thị.
 */
import { TICKS_PER_QUARTER, type SheetBox, type SheetMeasureGeom } from './model.js';
import { child, childNum, kids, parseXml, type XmlElement } from './xml.js';

interface PageLayout {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const num = (s: string | undefined) => (s === undefined || s === '' || Number.isNaN(Number(s)) ? undefined : Number(s));

function readPageLayout(pl: XmlElement | undefined, fallback?: PageLayout): PageLayout | undefined {
  const width = childNum(pl, 'page-width') ?? fallback?.width;
  const height = childNum(pl, 'page-height') ?? fallback?.height;
  if (!width || !height) return undefined;
  const m = kids(pl, 'page-margins').find((x) => !x.attrs.type || x.attrs.type === 'both' || x.attrs.type === 'odd') ?? child(pl, 'page-margins');
  return {
    width, height,
    left: childNum(m, 'left-margin') ?? fallback?.left ?? 0,
    right: childNum(m, 'right-margin') ?? fallback?.right ?? 0,
    top: childNum(m, 'top-margin') ?? fallback?.top ?? 0,
    bottom: childNum(m, 'bottom-margin') ?? fallback?.bottom ?? 0,
  };
}

/** Số khuông của một part (đọc <attributes><staves>) */
function stavesOf(xp: XmlElement): number {
  for (const m of kids(xp, 'measure')) {
    for (const a of kids(m, 'attributes')) {
      const s = childNum(a, 'staves');
      if (s) return s;
    }
  }
  return 1;
}

export interface SheetGeometry {
  pages: { widthTenths: number; heightTenths: number }[];
  measures: SheetMeasureGeom[];
}

/**
 * Trả về hình chữ nhật của từng ô nhịp trên trang gốc. Ô nhịp nào không đủ dữ liệu bố cục sẽ được chia đều
 * phần còn lại của hệ thống. Trả về null nếu MusicXML không có page-layout (không phải xuất từ OMR).
 */
export function extractSheetGeometry(xml: string): SheetGeometry | null {
  const root = parseXml(xml);
  const defaults = child(root, 'defaults');
  let page = readPageLayout(child(defaults, 'page-layout'));
  if (!page) return null;
  const defSys = child(defaults, 'system-layout');
  const defLeft = childNum(child(defSys, 'system-margins'), 'left-margin') ?? 0;
  const defRight = childNum(child(defSys, 'system-margins'), 'right-margin') ?? 0;
  const defSysDist = childNum(defSys, 'system-distance') ?? 100;
  const defTopDist = childNum(defSys, 'top-system-distance') ?? 70;
  const defStaffDist = childNum(child(defaults, 'staff-layout'), 'staff-distance') ?? 65;

  const parts = kids(root, 'part');
  const first = parts[0];
  if (!first) return null;
  const staves = parts.map(stavesOf);
  const partMeasures = parts.map((p) => kids(p, 'measure'));

  // ---- gom ô nhịp theo hệ thống
  interface Sys { page: number; top: number; left: number; right: number; height: number; measures: number[] }
  const systems: Sys[] = [];
  const pages: SheetGeometry['pages'] = [{ widthTenths: page.width, heightTenths: page.height }];
  let pageIdx = 0;
  let prevBottom = 0;

  partMeasures[0]!.forEach((xm, mi) => {
    const pr = child(xm, 'print');
    const newPage = mi > 0 && (pr?.attrs['new-page'] === 'yes' || (pr?.attrs['page-number'] !== undefined && num(pr.attrs['page-number'])! > pageIdx + 1));
    const newSystem = mi === 0 || newPage || pr?.attrs['new-system'] === 'yes' || !!child(pr, 'system-layout');
    if (newPage) {
      pageIdx++;
      page = readPageLayout(child(pr, 'page-layout'), page) ?? page;
      pages.push({ widthTenths: page!.width, heightTenths: page!.height });
    }
    if (newSystem) {
      const sl = child(pr, 'system-layout');
      const sm = child(sl, 'system-margins');
      const firstOnPage = mi === 0 || newPage;
      const top = firstOnPage
        ? page!.top + (childNum(sl, 'top-system-distance') ?? defTopDist)
        : prevBottom + (childNum(sl, 'system-distance') ?? defSysDist);
      // chiều cao hệ thống: các khuông của mọi part + khoảng cách giữa chúng
      let h = 0;
      parts.forEach((_, pi) => {
        const ppr = child(partMeasures[pi]![mi], 'print');
        const layouts = kids(ppr, 'staff-layout');
        for (let s = 0; s < staves[pi]!; s++) {
          if (pi > 0 || s > 0) {
            const lay = layouts.find((l) => num(l.attrs.number) === s + 1) ?? (s === 0 ? layouts.find((l) => !l.attrs.number) : undefined);
            h += childNum(lay, 'staff-distance') ?? defStaffDist;
          }
          h += 40;
        }
      });
      systems.push({
        page: pageIdx, top,
        left: page!.left + (childNum(sm, 'left-margin') ?? defLeft),
        right: page!.width - page!.right - (childNum(sm, 'right-margin') ?? defRight),
        height: h, measures: [],
      });
      prevBottom = top + h;
    }
    systems[systems.length - 1]!.measures.push(mi);
  });

  // ---- vị trí ngang từng ô nhịp + vị trí nốt theo tick
  const out: SheetMeasureGeom[] = [];
  let divisions = 1;
  systems.forEach((sys, si) => {
    const widths = sys.measures.map((mi) => num(partMeasures[0]![mi]!.attrs.width));
    const known = widths.reduce<number>((a, w) => a + (w ?? 0), 0);
    const unknown = widths.filter((w) => w === undefined).length;
    const fill = unknown ? Math.max(40, (sys.right - sys.left - known) / unknown) : 0;
    let x = sys.left;
    const pw = pages[sys.page]!.widthTenths;
    const ph = pages[sys.page]!.heightTenths;
    sys.measures.forEach((mi, k) => {
      const w = widths[k] ?? fill;
      const ticks = new Map<number, number>();
      const xm = partMeasures[0]![mi]!;
      let pos = 0;
      let lastStart = 0;
      for (const node of xm.children) {
        if (typeof node === 'string') continue;
        if (node.name === 'attributes') divisions = childNum(node, 'divisions') ?? divisions;
        const d = Math.round(((childNum(node, 'duration') ?? 0) * TICKS_PER_QUARTER) / divisions);
        if (node.name === 'backup') pos -= d;
        else if (node.name === 'forward') pos += d;
        else if (node.name === 'note') {
          const isChord = !!child(node, 'chord');
          const start = isChord ? lastStart : pos;
          const dx = num(node.attrs['default-x']);
          if (dx !== undefined && !child(node, 'grace')) {
            const px = (x + dx) / pw;
            const prev = ticks.get(start);
            ticks.set(start, prev === undefined ? px : Math.min(prev, px));
          }
          if (!isChord && !child(node, 'grace')) {
            lastStart = pos;
            pos += d;
          }
        }
      }
      const box: SheetBox = { page: sys.page, x: x / pw, y: (sys.top - 25) / ph, w: w / pw, h: (sys.height + 50) / ph };
      out.push({ ...box, measureIndex: mi, system: si, ticks: [...ticks.entries()].sort((a, b) => a[0] - b[0]) });
      x += w;
    });
  });
  return { pages, measures: out };
}

/** Vị trí x (tỉ lệ trang) của con trỏ phát tại `tick` trong ô nhịp, nội suy giữa các nốt */
export function cursorX(g: SheetMeasureGeom, tick: number, measureTicks: number): number {
  const pts: [number, number][] = [[0, g.x + g.w * 0.04], ...g.ticks, [measureTicks, g.x + g.w]];
  pts.sort((a, b) => a[0] - b[0]);
  for (let i = pts.length - 1; i >= 0; i--) {
    const [t0, x0] = pts[i]!;
    if (tick >= t0) {
      const nxt = pts[i + 1];
      if (!nxt || nxt[0] === t0) return x0;
      return x0 + ((x1(nxt) - x0) * (tick - t0)) / (nxt[0] - t0);
    }
  }
  return g.x;
}
const x1 = (p: [number, number]) => p[1];

/** Vùng cắt (có lề) quanh các ô nhịp, để nhận dạng lại hoặc cho người dùng đối chiếu */
export function regionOf(boxes: SheetBox[], pad = 0.012): SheetBox | null {
  if (!boxes.length) return null;
  const p = boxes[0]!.page;
  const same = boxes.filter((b) => b.page === p);
  const x0 = Math.max(0, Math.min(...same.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...same.map((b) => b.y)) - pad);
  const x1v = Math.min(1, Math.max(...same.map((b) => b.x + b.w)) + pad);
  const y1 = Math.min(1, Math.max(...same.map((b) => b.y + b.h)) + pad);
  return { page: p, x: x0, y: y0, w: x1v - x0, h: y1 - y0 };
}

/**
 * Tọa độ CHÍNH XÁC theo pixel từ dự án Audiveris (.omr → sheet#N/sheet#N.xml): kích thước ảnh, mỗi "stack"
 * (= một ô nhịp của cả hệ thống) với left/right, các "slot" (x-offset, time-offset theo phần nốt tròn),
 * và các dòng kẻ khuông để biết chiều cao hệ thống. `sheets[i]` là XML của trang i.
 * Trả về null nếu không đọc được gì.
 */
export function extractOmrGeometry(sheets: string[]): SheetMeasureGeom[] | null {
  const out: SheetMeasureGeom[] = [];
  let mi = 0;
  let sysIndex = 0;
  const attr = (tag: string, name: string) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return m ? m[1]! : undefined;
  };
  const frac = (s: string | undefined) => {
    if (!s) return 0;
    const [a, b] = s.split('/').map(Number);
    return b ? a! / b : a!;
  };
  sheets.forEach((xml, page) => {
    const pic = /<picture\s[^>]*>/.exec(xml)?.[0];
    const W = Number(attr(pic ?? '', 'width'));
    const H = Number(attr(pic ?? '', 'height'));
    if (!W || !H) return;
    const sysRe = /<system\s[^>]*>([\s\S]*?)<\/system>/g;
    let sm: RegExpExecArray | null;
    while ((sm = sysRe.exec(xml))) {
      const body = sm[1]!;
      // chiều cao hệ thống: dòng kẻ trên cùng / dưới cùng của mọi khuông
      let top = Infinity;
      let bottom = -Infinity;
      const linesRe = /<lines>([\s\S]*?)<\/lines>/g;
      let lm: RegExpExecArray | null;
      while ((lm = linesRe.exec(body))) {
        for (const p of lm[1]!.matchAll(/<point\s[^>]*y="([\d.]+)"/g)) {
          const y = Number(p[1]);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      if (!Number.isFinite(top)) continue;
      const interline = Math.max(8, (bottom - top) / 40 * 4); // ước lượng thô, chỉ để chừa lề
      const padTop = Math.max(interline * 2.5, 30);
      const padBottom = Math.max(interline * 3.5, 40); // lời ca nằm dưới khuông
      const stackRe = /<stack\s([^>]*)>([\s\S]*?)<\/stack>|<stack\s([^>]*)\/>/g;
      let st: RegExpExecArray | null;
      while ((st = stackRe.exec(body))) {
        const head = ' ' + (st[1] ?? st[3] ?? '');
        const left = Number(attr(head, 'left'));
        const right = Number(attr(head, 'right'));
        if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
        const ticks: [number, number][] = [];
        for (const s of (st[2] ?? '').matchAll(/<slot\s[^>]*>/g)) {
          const xo = Number(attr(s[0], 'x-offset'));
          const to = frac(attr(s[0], 'time-offset'));
          if (Number.isFinite(xo)) ticks.push([Math.round(to * 4 * TICKS_PER_QUARTER), (left + xo) / W]);
        }
        out.push({
          page, system: sysIndex, measureIndex: mi++,
          x: left / W, y: Math.max(0, top - padTop) / H, w: (right - left) / W, h: (bottom - top + padTop + padBottom) / H,
          ticks: ticks.sort((a, b) => a[0] - b[0]),
        });
      }
      sysIndex++;
    }
  });
  return out.length ? out : null;
}

/** Tín hiệu "vùng khó" lấy từ dự án Audiveris (không phụ thuộc bản nhạc đã dựng) */
export interface OmrSignals {
  /** Điểm tin cậy (grade của bộ phân loại Audiveris) theo ô nhịp: thấp nhất và trung bình */
  grades: { measureIndex: number; min: number; mean: number; count: number }[];
  /** Vùng đầu khuông giữa khoá nhạc và số chỉ nhịp/nốt đầu, khi Audiveris KHÔNG nhận ra hoá biểu.
   *  Có mực ở vùng này ⇒ nhiều khả năng sót hoá biểu (kiểm tra mực ở phía ứng dụng bằng ảnh nhị phân). */
  keyGaps: { page: number; system: number; firstMeasure: number; box: SheetBox; /** y các dòng kẻ (tỉ lệ trang) để bỏ qua khi đo mực */ lines: number[] }[];
}

export function extractOmrSignals(sheets: string[], geom: SheetMeasureGeom[]): OmrSignals {
  const grades = new Map<number, number[]>();
  const keyGaps: OmrSignals['keyGaps'] = [];
  const num = (tag: string, name: string) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return m ? Number(m[1]) : NaN;
  };
  let sysIndex = 0;
  sheets.forEach((xml, page) => {
    const pic = /<picture\s[^>]*>/.exec(xml)?.[0] ?? '';
    const W = num(pic, 'width');
    const H = num(pic, 'height');
    const il = num(/<interline\s[^>]*>/.exec(xml)?.[0] ?? '', 'main') || 20;
    if (!W || !H) return;
    const sysRe = /<system\s[^>]*>([\s\S]*?)<\/system>/g;
    let sm: RegExpExecArray | null;
    while ((sm = sysRe.exec(xml))) {
      const body = sm[1]!;
      const measures = geom.filter((g) => g.page === page && g.system === sysIndex);
      // ---- điểm tin cậy của nốt, dấu hoá theo vị trí x
      for (const m of body.matchAll(/<(head|alter|rest|flag|beam)\s([^>]*)>\s*<bounds x="([\d.]+)" y="[\d.]+" w="([\d.]+)"/g)) {
        const g = num(' ' + m[2]!, 'grade');
        if (!Number.isFinite(g)) continue;
        const cx = (Number(m[3]) + Number(m[4]) / 2) / W;
        const mm = measures.find((x) => cx >= x.x && cx < x.x + x.w);
        if (mm) grades.set(mm.measureIndex, [...(grades.get(mm.measureIndex) ?? []), g]);
      }
      // ---- đầu khuông: khoá nhạc có, hoá biểu không
      const bounds = (id: string) => {
        const m = new RegExp(`\\sid="${id}"[^>]*>\\s*<bounds x="([\\d.]+)" y="([\\d.]+)" w="([\\d.]+)" h="([\\d.]+)"`).exec(body);
        return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
      };
      for (const st of body.matchAll(/<staff\s[^>]*>([\s\S]*?)<\/staff>/g)) {
        const header = /<header\s([^>]*)>([\s\S]*?)<\/header>/.exec(st[1]!);
        if (!header || /<key>/.test(header[2]!)) continue;
        const clefId = /<clef>(\d+)<\/clef>/.exec(header[2]!)?.[1];
        const timeId = /<time>(\d+)<\/time>/.exec(header[2]!)?.[1];
        const clef = clefId ? bounds(clefId) : null;
        if (!clef) continue;
        const ys = [...st[1]!.matchAll(/<point\s[^>]*y="([\d.]+)"/g)].map((p) => Number(p[1]));
        if (!ys.length) continue;
        const time = timeId ? bounds(timeId) : null;
        const x0 = clef.x + clef.w + 0.25 * il;
        const x1 = (time ? time.x : num(' ' + header[1]!, 'stop')) - 0.25 * il;
        if (!(x1 - x0 > 0.6 * il)) continue;
        const y0 = Math.min(...ys) - il;
        const y1 = Math.max(...ys) + il;
        keyGaps.push({ page, system: sysIndex, firstMeasure: measures[0]?.measureIndex ?? -1, box: { page, x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H }, lines: [...new Set(ys)].map((y) => y / H) });
      }
      sysIndex++;
    }
  });
  return {
    grades: [...grades].map(([measureIndex, v]) => ({ measureIndex, min: Math.min(...v), mean: v.reduce((a, b) => a + b, 0) / v.length, count: v.length })),
    keyGaps,
  };
}
