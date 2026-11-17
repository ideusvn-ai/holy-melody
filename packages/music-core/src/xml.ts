/**
 * Bộ phân tích/ghi XML tối giản, không phụ thuộc DOM, đủ cho MusicXML.
 * Hỗ trợ: khai báo, DOCTYPE, comment, CDATA, entity chuẩn và số, thuộc tính, thẻ tự đóng.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export class XmlParseError extends Error {}

export function parseXml(src: string): XmlElement {
  let i = 0;
  const n = src.length;
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;

  const fail = (msg: string): never => {
    throw new XmlParseError(`${msg} (vị trí ${i})`);
  };

  while (i < n) {
    if (src[i] === '<') {
      if (src.startsWith('<?', i)) {
        const e = src.indexOf('?>', i);
        if (e < 0) fail('Thiếu ?>');
        i = e + 2;
      } else if (src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i);
        if (e < 0) fail('Comment không đóng');
        i = e + 3;
      } else if (src.startsWith('<![CDATA[', i)) {
        const e = src.indexOf(']]>', i);
        if (e < 0) fail('CDATA không đóng');
        stack[stack.length - 1]?.children.push(src.slice(i + 9, e));
        i = e + 3;
      } else if (src.startsWith('<!', i)) {
        // DOCTYPE, có thể có [ ... ]
        let depth = 0;
        let j = i + 2;
        for (; j < n; j++) {
          if (src[j] === '[') depth++;
          else if (src[j] === ']') depth--;
          else if (src[j] === '>' && depth === 0) break;
        }
        i = j + 1;
      } else if (src[i + 1] === '/') {
        const e = src.indexOf('>', i);
        const name = src.slice(i + 2, e).trim();
        const top = stack.pop();
        if (!top || top.name !== name) fail(`Thẻ đóng không khớp </${name}>`);
        i = e + 1;
      } else {
        i++;
        const nameStart = i;
        while (i < n && !/[\s/>]/.test(src[i]!)) i++;
        const el: XmlElement = { name: src.slice(nameStart, i), attrs: {}, children: [] };
        // thuộc tính
        for (;;) {
          while (i < n && /\s/.test(src[i]!)) i++;
          if (src[i] === '/' && src[i + 1] === '>') {
            i += 2;
            attach(el, true);
            break;
          }
          if (src[i] === '>') {
            i++;
            attach(el, false);
            break;
          }
          const aStart = i;
          while (i < n && !/[\s=/>]/.test(src[i]!)) i++;
          const aName = src.slice(aStart, i);
          while (/\s/.test(src[i]!)) i++;
          if (src[i] !== '=') fail(`Thiếu = sau thuộc tính ${aName}`);
          i++;
          while (/\s/.test(src[i]!)) i++;
          const q = src[i];
          if (q !== '"' && q !== "'") fail('Giá trị thuộc tính phải có dấu nháy');
          const e = src.indexOf(q!, i + 1);
          el.attrs[aName] = decode(src.slice(i + 1, e));
          i = e + 1;
        }
      }
    } else {
      const e = src.indexOf('<', i);
      const end = e < 0 ? n : e;
      const text = src.slice(i, end);
      if (stack.length && text.trim()) stack[stack.length - 1]!.children.push(decode(text));
      i = end;
    }
  }
  if (stack.length) fail(`Thẻ <${stack[stack.length - 1]!.name}> không đóng`);
  if (!root) fail('Không có phần tử gốc');
  return root!;

  function attach(el: XmlElement, selfClosing: boolean) {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;
    if (!selfClosing) stack.push(el);
  }
}

// ---------------------------------------------------------------- truy vấn

export const isEl = (x: XmlNode): x is XmlElement => typeof x !== 'string';
export const kids = (el: XmlElement | undefined, name?: string): XmlElement[] =>
  el ? (el.children.filter(isEl) as XmlElement[]).filter((c) => !name || c.name === name) : [];
export const child = (el: XmlElement | undefined, name: string): XmlElement | undefined => kids(el, name)[0];
export const text = (el: XmlElement | undefined): string =>
  el ? el.children.map((c) => (typeof c === 'string' ? c : text(c))).join('') : '';
export const childText = (el: XmlElement | undefined, name: string): string | undefined => {
  const c = child(el, name);
  return c ? text(c).trim() : undefined;
};
export const childNum = (el: XmlElement | undefined, name: string): number | undefined => {
  const t = childText(el, name);
  return t === undefined || t === '' ? undefined : Number(t);
};

// ---------------------------------------------------------------- ghi

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Builder đơn giản: el('note', {id}, [el('pitch', {}, [...])]) */
export function el(name: string, attrs: Record<string, string | number | undefined> = {}, children: (XmlNode | undefined | false)[] = []): XmlElement {
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) a[k] = String(v);
  return { name, attrs: a, children: children.filter((c): c is XmlNode => c !== undefined && c !== false) };
}
export const tel = (name: string, value: string | number, attrs: Record<string, string | number | undefined> = {}) =>
  el(name, attrs, [String(value)]);

export function serializeXml(root: XmlElement, header = ''): string {
  const out: string[] = [header];
  const walk = (e: XmlElement, depth: number) => {
    const pad = '  '.repeat(depth);
    const attrs = Object.entries(e.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
    if (e.children.length === 0) {
      out.push(`${pad}<${e.name}${attrs}/>`);
    } else if (e.children.every((c) => typeof c === 'string')) {
      out.push(`${pad}<${e.name}${attrs}>${escapeXml((e.children as string[]).join(''))}</${e.name}>`);
    } else {
      out.push(`${pad}<${e.name}${attrs}>`);
      for (const c of e.children) {
        if (typeof c === 'string') out.push(pad + '  ' + escapeXml(c));
        else walk(c, depth + 1);
      }
      out.push(`${pad}</${e.name}>`);
    }
  };
  walk(root, 0);
  return out.filter((l) => l !== '').join('\n') + '\n';
}
