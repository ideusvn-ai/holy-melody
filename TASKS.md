# Holy Melody — TASKS

Cập nhật: 2026-11-17 · Phase hiện tại: **1 (Foundation)**, kèm một phần Phase 2–3 đã làm sớm theo yêu cầu.
Ký hiệu: ✅ xong + có test · 🟡 đã viết, chưa kiểm chứng được trong môi trường hiện tại · ⬜ chưa làm

## Đã kiểm chứng trong phiên này

| Hạng mục | Kết quả |
|---|---|
| `music-core` | **46/46 test** (`npm test -w @holy-melody/music-core`) + `tsc --strict` sạch |
| `score-renderer` | **4/4 test** dàn trang (không tràn lề, không chồng lời, khóa nhạc) |
| Backend PHP | **11/11 unit test** (`php backend/tests/run.php`); 6 test tích hợp MySQL **bị bỏ qua** vì không có MySQL |
| Giao diện desktop | Bundle bằng esbuild + Tailwind, chạy trong Chromium headless: phát nhạc, highlight 4 bè theo audio clock, sửa nốt, Undo, đồng bộ 3 tab, Trợ lý soạn nhạc, Hợp âm thông minh, Lời ca — **không lỗi runtime** |

## Phase 1 — Architecture & Foundation

- ✅ Khảo sát thư viện, giấy phép → `docs/ARCHITECTURE.md`, `docs/LICENSING.md`
- ✅ Monorepo (npm workspaces): `apps/desktop`, `packages/*`, `backend`
- ✅ Canonical Score Model, ID ổn định, tick nguyên 480/quarter, tuplet chính xác bằng phân số
- ✅ MusicXML import/export (partwise; giữ ID, lời Việt, hợp âm, repeat/volta, ngắt trang, nhạc cụ chuyển giọng, láy, liên, nốt hoa mỹ, font lời ca)
- ✅ MIDI import (lượng tử hóa, tách nốt qua vạch nhịp bằng dấu nối, đặt tên nốt theo hóa biểu) / export (SMF type 1, tempo, nhịp, hóa biểu, program, unroll repeat)
- ✅ CommandHistory: Undo/Redo nhiều cấp, sự kiện `score:changed` để đồng bộ tab
- ✅ Transpose (bán cung / quãng / giọng đích, chọn cách viết ít dấu hóa, cập nhật hợp âm + hóa biểu, theo bè/đoạn)
- ✅ Playback timeline có noteId, unroll repeat/volta, tempo map, dynamics → velocity, staccato
- 🟡 Desktop shell Tauri 2 + React: mã nguồn đầy đủ; **chưa `npm install`/`cargo build`** (không có mạng trong môi trường build)
- 🟡 Rust: lưu dự án SQLite + autosave + version history + khôi phục sau crash, ghi file nguyên tử, PKCE (có unit test Rust theo vector RFC 7636) — **chưa biên dịch**
- ✅ UI system: sáng/tối, giảm chuyển động, panel co giãn + ghi nhớ, command palette, kéo thả file, toast, phím tắt
- ✅ SQL migration đầy đủ (users, wallets, sổ cái credit, gói, đơn hàng, sự kiện thanh toán, AI jobs/outputs/chi phí, admin, audit, rate limit, releases, error logs)

## Làm sớm theo yêu cầu bổ sung

- ✅ **Trợ lý soạn nhạc** (chỉ gợi ý, bỏ qua/tắt quy tắc, lưu cùng dự án): quãng nhảy, tritone, bù bước nhảy, cảm âm, âm vực SATB & cộng đoàn, song song 5/8, bắt chéo, khoảng cách bè, cấu trúc thánh ca (kết chủ âm, cadence, câu 2/4/8 ô, cao trào, ô lấy đà), **dấu thanh tiếng Việt ↔ hướng giai điệu**, nốt thiếu lời, ô thiếu/thừa phách
- ✅ **Hợp âm thông minh (cục bộ, miễn phí)**: Viterbi trên hòa âm chức năng, 9 phong cách, 3 phương án khác biệt, Preview/Compare/Apply/Regenerate/Undo, không đổi giai điệu
- ✅ **Lời ca thông minh**: dán cả đoạn → tách âm tiết (Việt / "A-men" / "_" ngân), bỏ qua nốt nối & trong luyến, nhiều phiên khúc, báo thừa/thiếu âm tiết; chỉnh font, cỡ chữ, cách khuông, cách giữa các lời, số phiên khúc, in nghiêng, dịch từng âm tiết
- ✅ Ký âm: liên 3/5/6/7, hợp âm ba (+ thể đảo), thêm quãng 2–8, dấu nối qua vạch, dấu luyến, trill/mordent/turn, nốt hoa mỹ, staccato/tenuto/accent/marcato/fermata, pp–ff, dấu lặp, vạch kép/kết, đổi hóa biểu/số chỉ nhịp
- ✅ Renderer cơ bản: chùm nốt theo phách, đường cong nối/luyến (cả qua dòng), ngoặc liên, cường độ, láy, giãn cách theo thang log, lề theo khổ giấy, cân bằng dòng cuối
- ✅ Engine phát Web Audio (audio clock thật, lookahead scheduling, loop, metronome, count-in, mute/solo, tốc độ không đổi cao độ, transpose phát) — synth cơ bản, chờ SoundFont ở Phase 2
- ✅ Backend: xác minh Google ID token RS256 (JWKS, iss/aud/exp), session token băm SHA-256, CSRF cho cookie, ví credit idempotent + `FOR UPDATE`, cấp 100 credit một lần theo `sub`, PayOS/VNPay/MoMo (ký + xác minh), webhook idempotent, AI job queue (SKIP LOCKED, lease, retry không tốn credit, hoàn credit một lần), admin (thống kê, chỉnh credit có lý do + audit, giá AI), rate limit
- 🟡 Test tích hợp DB (signup bonus một lần, không âm, retry không trừ hai lần, webhook lặp, hoàn credit, 5 tiến trình tranh chấp) — **đã viết, chưa chạy** (cần MySQL 8 / MariaDB 10.6)

## Chưa làm / điều kiện còn thiếu

| Hạng mục | Phase | Cần gì |
|---|---|---|
| `npm install`, `tauri build`, chạy trên macOS/Windows thật | 1→8 | Máy có mạng; Rust + Xcode CLT (macOS) / MSVC + WebView2 (Windows) |
| Renderer Verovio (khắc bản chuẩn, xuất PDF/SVG/PNG vector) | 2–3 | Gói `verovio` (LGPL) |
| Engine Rust rustysynth + cpal, SoundFont, xuất WAV/MP3, reverb/chorus/pan | 2 | Crate + SoundFont có giấy phép phân phối |
| MIDI keyboard ngoài (midir / Web MIDI), ghi real-time | 2–3 | |
| D.C./D.S./Coda; phát nốt hoa mỹ và láy | 2 | |
| MXL (nén), Smart Layout + preset, A5 hymnal, print preview, PDF | 3 | |
| OMR (Audiveris tiến trình riêng / mô hình ML), màn hình hiệu đính | 4 | Quyết định pháp lý về AGPL; bộ dữ liệu thánh ca VN để đánh giá |
| AI Singer (SVS theo nốt, tiếng Việt), AI Harmony/Lyrics qua provider, AI worker | 5 | Provider/voicebank tiếng Việt có hợp đồng; GPU worker |
| Đăng nhập Google trên desktop (loopback listener + keychain) | 6 | OAuth client ID (Desktop + Web) |
| Kết nối sandbox PayOS/VNPay/MoMo, đối chiếu đặc tả mới nhất | 6 | Tài khoản merchant sandbox |
| Admin dashboard UI, website công khai, trang tài khoản | 6–7 | |
| Ký mã, notarization, auto-update có chữ ký | 8 | Apple Developer ID, chứng chỉ Authenticode |

## Cách chạy thử

```bash
# lõi âm nhạc + renderer (Node ≥ 20, tsx)
cd packages/music-core && npx tsx --test tests/*.test.ts
cd packages/score-renderer && npx tsx --test tests/*.test.ts

# backend (PHP 8.3)
php backend/tests/run.php
# test tích hợp: tạo CSDL trống rồi
HM_TEST_DB_HOST=127.0.0.1 HM_TEST_DB_NAME=hm_test HM_TEST_DB_USER=root php backend/tests/run.php

# desktop (máy có mạng)
npm install
npm run desktop:dev        # Tauri dev
npm run desktop:build      # .dmg / .msi

# xem nhanh giao diện không cần npm install (bản preview esbuild)
node scripts/preview/build.mjs && python3 -m http.server 8765 -d scripts/preview/dist
```
