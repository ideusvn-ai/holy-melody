# Holy Melody — Kế hoạch triển khai

Mỗi phase kết thúc bằng: build, test, sửa lỗi, cập nhật `TASKS.md` (hoàn thành / chưa / cách chạy thử). Không phase nào được đánh dấu xong khi test chưa qua.

## Phase 1 — Architecture & Foundation *(đang thực hiện)*
- Khảo sát thư viện + giấy phép → `docs/ARCHITECTURE.md`, `docs/LICENSING.md`
- Monorepo npm workspaces + Cargo workspace
- `music-core`: Canonical Score Model, ID ổn định, MusicXML import/export, MIDI import/export, transpose, CommandHistory (undo/redo), playback timeline có noteId — kèm test
- Desktop shell Tauri 2 + React: top bar, 3 tab, sidebar trái/phải co giãn, bottom transport, theme sáng/tối, giảm chuyển động, store dùng chung
- Rust: lệnh IPC dự án (SQLite), khung audio engine (trait `Synth`)
- Backend PHP: router, cấu hình env, MySQLi + transaction helper, migrations đầy đủ, xác minh Google ID token, session, wallet (idempotent), payment webhook (PayOS/VNPay/MoMo adapter), AI job + refund — kèm test

**Điều kiện ngoài**: cài npm/cargo dependencies (cần mạng), MySQL server để chạy test tích hợp.

## Phase 2 — Music Core hoàn chỉnh
- Verovio WASM renderer, map ID nốt ↔ `<g id>`
- Rust audio engine: rustysynth + cpal, audio-clock event, seek, loop, count-in, metronome, mute/solo, tempo/speed, transpose playback
- Highlight theo audio clock, auto-scroll/lật trang
- Chọn ô nhịp/khuông/bè (kéo chuột) + Play/Loop Selection, Play From Here
- Virtual piano + Web MIDI / midir cho MIDI keyboard
- Mixer (volume, pan, reverb, chorus), đổi SoundFont
- Xuất WAV (render offline), MP3 nếu có encoder hợp lệ
- Repeat/volta/D.C./D.S./Coda unroll

## Phase 3 — Score Editor
- Wizard dự án, template (Solo, Piano, Lead Sheet, SATB, Hymn…)
- Nhập nốt: chuột, phím (A–G, 1–7 trường độ), step-time, MIDI keyboard, real-time record
- Chỉnh sửa: chọn nhiều, kéo thả snapping, copy/paste, insert/delete/split/join measure
- Lyrics tiếng Việt (phân âm tiết, melisma, nhiều lời), chord symbols, dynamics, articulations
- Layout: page/continuous/focus/print preview, Smart Layout + preset, A4/A5
- Xuất PDF vector, PNG, SVG, MXL
- Command palette, trang phím tắt

## Phase 4 — OMR
- Phân loại file: PDF vector / PDF scan / ảnh
- Tiền xử lý ảnh (deskew, binarize, dewarp)
- `OmrEngine` adapters: Audiveris CLI (tiến trình riêng), engine ML trong worker
- Tiến trình 10 bước, confidence map, màn hình hiệu đính trước khi phát
- Benchmark OMR trên fixture thánh ca Việt Nam

## Phase 5 — AI
- `ai-provider-sdk`: interface Harmony / Lyrics / SingingSynth / Accompaniment / Mixing
- AI Harmony (preview/compare/apply/undo, không đổi giai điệu)
- AI worker (Python): music21, SVS provider, MIDI arrangement, mix/master (ffmpeg/sox)
- Job queue bền vững (đóng app không mất job), waveform/timeline, export WAV/MP3/FLAC, stem khi pipeline thực sự tạo
- Bộ đánh giá Strict Melody (sai lệch pitch/onset)

## Phase 6 — Accounts & Payments
- Đăng nhập Google desktop (PKCE loopback) + keychain
- Kết nối PayOS/VNPay/MoMo sandbox, kiểm tra trạng thái giao dịch
- Admin dashboard (phân quyền, điều chỉnh credit có audit log, biểu đồ)

## Phase 7 — Public Website
- Landing, Features, How it works, Showcase, Download (nhận diện OS, checksum), Pricing, FAQ
- Account dashboard (credit, giao dịch, AI jobs, tải lại kết quả)
- SEO, Open Graph, sitemap, a11y

## Phase 8 — Testing & Release
- Integration/performance/security tests
- GitHub Actions: macOS arm64/x64 `.dmg`, Windows x64 `.msi`
- Code signing / notarization (khi có chứng chỉ), Tauri updater có chữ ký
- Tài liệu phát hành
