/**
 * Tìm các khuông nhạc và HỆ THỐNG (dòng nhạc) trên ảnh xám — rất nhanh, chạy trong ứng dụng trước khi gọi Audiveris,
 * để nhận dạng riêng hệ thống đầu tiên (phát được ngay) thay vì chờ cả trang.
 *  - dòng kẻ: hàng điểm ảnh có tỉ lệ điểm đen cao; 5 dòng cách đều ≈ interline = một khuông;
 *  - hai khuông liền nhau thuộc cùng hệ thống khi có vạch dọc (vạch nhịp đầu dòng / ngoặc) nối liền chúng
 *    — piano (khuông đôi) và SATB hai khuông vì vậy luôn được giữ trọn trong một vùng cắt.
 */
export interface StaffBand {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SystemBand {
  top: number;
  bottom: number;
  left: number;
  right: number;
  staves: StaffBand[];
}

export function detectSystems(
  gray: Uint8Array | Uint8ClampedArray, width: number, height: number, stride = 1, interline: number, threshold = 160,
): SystemBand[] {
  const px = (x: number, y: number) => gray[(y * width + x) * stride]! < threshold;
  // 1. độ đen theo hàng (lấy mẫu mỗi 2 cột)
  const step = 2;
  const samples = Math.ceil(width / step);
  const rows = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x += step) if (px(x, y)) n++;
    rows[y] = n / samples;
  }
  // 2. các dòng kẻ: chuỗi hàng liên tiếp có độ đen ≥ 30%
  const lines: { y: number; t: number }[] = [];
  for (let y = 0; y < height; y++) {
    if (rows[y]! < 0.3) continue;
    let e = y;
    while (e + 1 < height && rows[e + 1]! >= 0.3) e++;
    if (e - y + 1 <= Math.max(3, interline / 3)) lines.push({ y: (y + e) / 2, t: e - y + 1 });
    y = e;
  }
  // 3. khuông = 5 dòng cách đều ~interline
  const staves: StaffBand[] = [];
  for (let i = 0; i + 4 < lines.length; ) {
    const g = lines.slice(i, i + 5);
    const gaps = g.slice(1).map((l, k) => l.y - g[k]!.y);
    if (gaps.every((d) => Math.abs(d - interline) <= Math.max(2, interline * 0.3))) {
      const top = Math.floor(g[0]!.y);
      const bottom = Math.ceil(g[4]!.y);
      const mid = Math.round(g[2]!.y);
      // biên trái/phải: đoạn đen dài nhất trên dòng giữa (cho phép đứt 1–2 px)
      let best = [0, 0];
      let s = -1;
      let holes = 0;
      for (let x = 0; x <= width; x++) {
        const on = x < width && (px(x, mid) || px(x, Math.max(0, mid - 1)) || px(x, Math.min(height - 1, mid + 1)));
        if (on) {
          if (s < 0) s = x;
          holes = 0;
        } else if (s >= 0 && ++holes > 3) {
          if (x - holes - s > best[1]! - best[0]!) best = [s, x - holes];
          s = -1;
          holes = 0;
        }
      }
      staves.push({ top, bottom, left: best[0]!, right: best[1]! });
      i += 5;
    } else i++;
  }
  // 4. gom khuông thành hệ thống: có vạch dọc nối khuông trên với khuông dưới ở gần mép trái
  const systems: SystemBand[] = [];
  const connected = (a: StaffBand, b: StaffBand) => {
    const x0 = Math.max(0, Math.min(a.left, b.left) - Math.round(interline * 2.5));
    const x1 = Math.min(width - 1, Math.max(a.left, b.left) + Math.round(interline * 1.5));
    const span = b.top - a.bottom;
    if (span <= 0) return true;
    for (let x = x0; x <= x1; x++) {
      let dark = 0;
      for (let y = a.bottom; y <= b.top; y++) if (px(x, y) || (x + 1 < width && px(x + 1, y))) dark++;
      if (dark / (span + 1) >= 0.9) return true;
    }
    return false;
  };
  for (const st of staves) {
    const cur = systems[systems.length - 1];
    const prev = cur?.staves[cur.staves.length - 1];
    if (cur && prev && connected(prev, st)) {
      cur.staves.push(st);
      cur.bottom = st.bottom;
      cur.left = Math.min(cur.left, st.left);
      cur.right = Math.max(cur.right, st.right);
    } else {
      systems.push({ top: st.top, bottom: st.bottom, left: st.left, right: st.right, staves: [st] });
    }
  }
  return systems;
}

/**
 * Vùng cắt (px) cho hệ thống `i`: rộng hết trang; phía trên lấy thêm khoảng trống cho nốt phụ/ký hiệu,
 * phía dưới lấy tới gần hệ thống kế tiếp (lời ca nằm ở đó). Trả về null nếu không có hệ thống này.
 */
export function systemCrop(systems: SystemBand[], i: number, width: number, height: number, interline: number): { x: number; y: number; w: number; h: number } | null {
  const s = systems[i];
  if (!s) return null;
  const prev = systems[i - 1];
  const next = systems[i + 1];
  const above = prev ? (s.top - prev.bottom) * 0.4 : Math.min(s.top, Math.max(interline * 6, s.top * 0.5));
  const below = next ? (next.top - s.bottom) * 0.7 : Math.min(height - s.bottom, interline * 10);
  const y = Math.max(0, Math.floor(s.top - above));
  const y2 = Math.min(height, Math.ceil(s.bottom + below));
  return { x: 0, y, w: width, h: y2 - y };
}
