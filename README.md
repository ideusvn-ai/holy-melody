# Holy Melody

**Đọc bản nhạc. Soạn nhạc. Biến giai điệu thành tiếng hát.**

Phần mềm desktop (macOS Apple Silicon/Intel, Windows 10/11) gồm ba khu vực dùng chung một bản nhạc:

| Tab | Chức năng |
|---|---|
| **PLAYER** | Mở MusicXML/MIDI (ảnh/PDF qua OMR ở Phase 4), phát với highlight nốt theo audio clock, chọn đoạn để phát/lặp, piano ảo, mixer |
| **SCORE EDITOR** | Soạn nốt, liên 3, hợp âm, luyến láy, lời ca thông minh, chuyển giọng, Trợ lý soạn nhạc, Hợp âm thông minh |
| **AI SINGER** | Biến bản nhạc có lời thành bài hát (Strict Melody Mode – Phase 5) |

Soạn và phát hoạt động offline, không cần đăng nhập. AI cần tài khoản Google và credit (100 credit miễn phí cho tài khoản mới).

- Kiến trúc: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Kế hoạch: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Tiến độ & cách chạy: [`TASKS.md`](TASKS.md)
- Giấy phép bên thứ ba: [`docs/LICENSING.md`](docs/LICENSING.md)

```text
holy-melody/
├── apps/desktop/          Tauri 2 + React + TypeScript (src/, src-tauri/)
├── apps/website/          Website PHP (Phase 7)
├── packages/music-core/   Canonical Score Model, MusicXML, MIDI, transpose, undo, advisor, harmony, lyrics
├── packages/score-renderer/  Layout SVG (renderer dự phòng; Verovio ở Phase 2)
├── packages/midi-engine/  Engine phát (Web Audio; Rust ở Phase 2)
├── packages/omr-adapter/  Giao diện OMR
├── packages/ai-provider-sdk/  Giao diện provider AI
├── packages/shared-types/ DTO API
├── services/ai-worker/    Worker AI (Phase 5)
├── backend/               PHP 8.3 API + MySQL migrations + tests
└── scripts/preview/       Build preview giao diện không cần npm install
```
