/** Tiến trình nhận dạng đang chạy nền (theo id bản nhạc), để hiển thị trên đầu trang bản gốc */
import { create } from 'zustand';

export const OMR_STEPS = [
  'Đọc file', 'Phân tích trang', 'Nhận dạng khuông nhạc', 'Nhận dạng khoá nhạc', 'Nhận dạng nốt và dấu hoá',
  'Nhận dạng trường độ và dấu lặng', 'Nhận dạng nhịp và ô nhịp', 'Nhận dạng lời ca', 'Chuyển đổi sang MusicXML', 'Hoàn tất',
];

interface OmrProgressState {
  stage: Record<string, number>;
  set(scoreId: string, stage: number): void;
}

export const useOmrProgress = create<OmrProgressState>((set, get) => ({
  stage: {},
  set(scoreId, stage) {
    if ((get().stage[scoreId] ?? 0) >= stage) return;
    set({ stage: { ...get().stage, [scoreId]: stage } });
  },
}));
