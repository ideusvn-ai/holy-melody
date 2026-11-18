/**
 * Ước lượng khoảng cách dòng kẻ khuông (interline, px) từ ảnh xám, như bước SCALE của Audiveris nhưng rất nhanh:
 * lấy mẫu các cột dọc, đo cặp (đoạn đen mảnh + đoạn trắng) lặp lại; giá trị xuất hiện nhiều nhất là interline.
 * Dùng để thu nhỏ ảnh về mức Audiveris đọc nhanh nhất mà chưa mất chính xác (≈ 14 px).
 */
export function estimateInterline(gray: Uint8Array | Uint8ClampedArray, width: number, height: number, stride = 1, threshold = 160): number | null {
  const hist = new Map<number, number>();
  const cols = 48;
  const maxLine = Math.max(3, Math.round(height / 600));
  for (let c = 1; c < cols; c++) {
    const x = Math.floor((width * (0.1 + (0.8 * c) / cols)));
    let run = 0;
    let black = false;
    let lastBlack = -1; // độ dài đoạn đen trước đó
    let white = 0;
    for (let y = 0; y < height; y++) {
      const v = gray[(y * width + x) * stride]!;
      const isBlack = v < threshold;
      if (isBlack === black) {
        run++;
        continue;
      }
      if (black) {
        // kết thúc đoạn đen
        if (run <= maxLine && lastBlack >= 0 && lastBlack <= maxLine && white > 2) {
          const d = white + run;
          hist.set(d, (hist.get(d) ?? 0) + 1);
        }
        lastBlack = run;
      } else {
        white = run;
      }
      black = isBlack;
      run = 1;
    }
  }
  let best = 0;
  let bestCount = 0;
  for (const [d, n] of hist) {
    if (d < 6 || d > 80) continue;
    // gộp ±1 px (ảnh quét không đều)
    const n3 = n + (hist.get(d - 1) ?? 0) + (hist.get(d + 1) ?? 0);
    if (n3 > bestCount) {
      best = d;
      bestCount = n3;
    }
  }
  return bestCount >= 12 ? best : null;
}

/**
 * Tỉ lệ thu nhỏ cho chế độ nhanh: đưa interline về ~15 px. Đo thực tế (Audiveris 5.11, 3 bản nhạc): 75% kích thước
 * nhanh hơn ~20–25%, nhưng dưới ~14 px bắt đầu sót nốt và dưới 11 px Audiveris từ chối. Bộ ước lượng này cho kết quả
 * cao hơn Audiveris ~1 px nên trừ đi trước khi tính.
 */
export function fastOmrScale(interline: number | null, target = 15): number {
  if (!interline) return 1;
  const il = interline - 1;
  if (il <= target + 1) return 1;
  return target / il;
}
