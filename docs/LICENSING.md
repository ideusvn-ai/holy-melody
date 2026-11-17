# Rà soát giấy phép bên thứ ba

Trạng thái: **sơ bộ** — phải xác minh lại bằng file LICENSE của đúng phiên bản trước mỗi release. Không phải tư vấn pháp lý.

| Thành phần | Giấy phép | Cách dùng dự kiến | Rủi ro / điều kiện |
|---|---|---|---|
| Tauri 2 | MIT / Apache-2.0 | Nhúng | Thấp |
| React, Zustand, Vite, Tailwind | MIT | Nhúng | Thấp |
| shadcn/ui, Radix | MIT | Copy component | Thấp |
| Motion (Framer Motion) | MIT | Nhúng | Thấp |
| Verovio | LGPL-3.0 | WASM tách file riêng, người dùng có thể thay | Phải cung cấp nguồn/khả năng thay thế thư viện; ghi notice |
| OpenSheetMusicDisplay | BSD-3-Clause | Dự phòng renderer | Thấp |
| VexFlow | MIT | Preview nhập nốt | Thấp |
| rustysynth | MIT | Synth chính | Thấp |
| cpal | Apache-2.0 | Audio output | Thấp |
| FluidSynth | LGPL-2.1 | Phương án thay thế, link động | Điều kiện LGPL |
| rusqlite / SQLite | MIT / Public domain | Lưu dự án | Thấp |
| music21 | BSD-3-Clause | AI worker (server) | Thấp |
| MuseScore CLI | GPL-3.0 | Chỉ gọi tiến trình do người dùng tự cài; không phân phối kèm | Không link, không bundle |
| Audiveris | AGPL-3.0 | Tiến trình riêng, tải riêng; hoặc chạy trên server phải công bố mã nguồn phần sửa đổi | **Cao** – cần quyết định pháp lý |
| oemer / homr / SMT | Cần xác minh | Engine OMR ML trong worker | Kiểm tra cả giấy phép **trọng số mô hình** và dataset huấn luyện |
| Font SMuFL Bravura | SIL OFL 1.1 | Nhúng vào app và PDF | Cho phép nhúng |
| SoundFont (GeneralUser GS / FluidR3_GM) | Cần xác minh | Âm thanh mặc định | Kiểm tra quyền phân phối lại |
| Voicebank SVS | Theo hợp đồng | AI Singer | Cần hợp đồng ca sĩ cho dữ liệu giọng tiếng Việt |
