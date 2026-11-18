# Holy Melody — TASKS

Cập nhật: 2026-11-17. Ký hiệu: ✅ xong và đã kiểm chứng · 🟢 xong, đã biên dịch trên CI nhưng cần thử trên máy thật · 🔑 code xong, cần tài khoản/khóa bên ngoài để chạy · ⬜ chưa làm

## Cách kiểm chứng
- **GitHub Actions** (mỗi lần đẩy lên `main`): test lõi + backend, kiểm tra kiểu TS, `cargo check` + `cargo test`, build `.dmg` (Apple Silicon, Intel) và `.exe`/`.msi`, tạo Release. Kết quả + log ghi vào nhánh `ci-status`.
- **Cục bộ**: `npm test` (music-core 48 test + renderer 4 test), `php backend/tests/run.php` (12 unit + 7 test DB cần MySQL).
- **Giao diện**: bản preview chạy trong Chromium headless (phát nhạc, highlight, chỉnh sửa, xuất PDF).

## Desktop
| Hạng mục | Trạng thái |
|---|---|
| Canonical Score Model, MusicXML / MXL / MIDI nhập–xuất, Undo/Redo, transpose | ✅ |
| Ba tab dùng chung một bản nhạc, đồng bộ tức thì | ✅ |
| Renderer SVG: chùm, nối, luyến, liên, láy, dấu diễn tấu, cường độ, lời ca nhiều lời, lề theo khổ giấy | ✅ (renderer riêng của dự án; Verovio chưa tích hợp) |
| In / Lưu PDF vector theo khổ A4/A5/Letter, dọc/ngang, phân trang, số trang; SVG; PNG 300 dpi | ✅ PDF đã kiểm tra · 🟢 lệnh in trong app |
| Engine âm thanh SoundFont (rustysynth + cpal): phát, metronome, count-in, loop, tốc độ, mixer âm lượng/pan/reverb | 🟢 |
| Xuất WAV (render SoundFont offline) | 🟢 |
| Highlight theo audio clock, phát vùng chọn, phát từ nốt, piano ảo | ✅ (Web Audio) · 🟢 (engine Rust) |
| Bàn phím MIDI ngoài: chơi thử + nhập step-time, hợp âm | 🟢 |
| Score Editor: nhập/sửa nốt, hợp âm ba, liên 3/5/6/7, nối, luyến, láy, nốt hoa mỹ, cường độ, dấu lặp, hóa biểu, số chỉ nhịp | ✅ |
| Trợ lý soạn nhạc (quy tắc, cấu trúc thánh ca, dấu thanh tiếng Việt) – chỉ gợi ý | ✅ |
| Hợp âm thông minh cục bộ (3 phương án, 9 phong cách, preview/apply/undo) | ✅ |
| Lời ca thông minh (dán đoạn lời, phiên khúc, font/cỡ/vị trí) | ✅ |
| Audiveris 5.11 đóng gói kèm bộ cài (macOS arm64/x64, Windows), không cần cài riêng | 🟢 CI tự tải + đóng gói |
| Player mở ảnh/PDF: hiển thị bản gốc (PDF vẽ vector theo zoom) + lớp phủ nhận dạng để phát MIDI, tô sáng ô nhịp, con trỏ theo phách (tọa độ pixel từ .omr) | ✅ kiểm tra bằng kết quả Audiveris thật |
| Màn hình chào: chỉ Tạo mới / Mở bản nhạc, không tạo sẵn score | ✅ |
| Chuyển sang Edit: 10 credit/ file gốc (idempotent, máy chủ), Music Rule Validator (trường độ, dấu hoá, dấu nối, phân bè, liên âm, cấu trúc; không tự sửa ô lấy đà/cadenza/ký âm đặc biệt) | ✅ kiểm thử đơn vị + tích hợp CSDL trên CI |
| Phát hiện vùng khó: điểm tin cậy của Audiveris theo ô, nghi sót hoá biểu (đo mực trên ảnh nhị phân) | ✅ kiểm thử trên mẫu thật |
| Nhận dạng lại theo vùng (cắt dòng nhạc, phóng to/nhị phân hoá, chạy lại Audiveris, chỉ thay ô lỗi khi số lỗi giảm) | 🟢 chưa chạy thử trong app thật |
| Đối chiếu thủ công: ảnh gốc từng ô ↔ kết quả, xác nhận/sửa/để sau; lưu kết quả + tọa độ trong dự án (.holymelody dạng zip kèm file gốc) | ✅ preview |
| OMR 2 mức: Player nhanh (ảnh thu nhỏ về interline ~15 px, đo trên CI: nhanh hơn 20–35%), Editor kỹ (độ phân giải gốc, có lời ca) | ✅ |
| AI đọc ảnh vùng khó khi sang Editor (máy chủ gọi mô hình đọc ảnh; chỉ nhận khi ít lỗi hơn; giới hạn lượt) | 🟢 cần HM_ANTHROPIC_API_KEY trên máy chủ, chưa chạy thật |
| Player: panel trái (nhạc cụ, âm lượng MIDI, âm lượng hợp âm, transpose, tempo), bỏ mixer + panel phải | ✅ |
| Đệm hợp âm (bass + hợp âm theo nhịp 4/4, 3/4, 2/4, 6/8…), dạo đầu câu cuối, đếm vào kiểu karaoke trên dòng nhạc đầu | ✅ |
| Chọn nốt (cả trên ảnh gốc) → Play phát từ nốt đó | ✅ |
| Chỉ còn Player; Editor qua "Chuyển sang Editor" (đăng nhập) / Tạo mới / mở .holymelody (không cần đăng nhập); PDF cần đăng nhập; nút AI Singer trong Editor | ✅ |
| Nhập nốt: bấm lên khuông đặt nốt (ghi đè dấu lặng, tự bù lặng), nốt mờ xem trước, A–G tự sang nốt kế, theo hoá biểu | ✅ |
| Font nhạc Bravura (SMuFL): khoá, dấu hoá, số chỉ nhịp, dấu lặng đúng tỉ lệ | ✅ |
| Tay nắm kéo vị trí lời ca trong Editor | ✅ |
| Đọc trực tiếp ký hiệu từ PDF vector (không cần OMR) | ⏳ ý tưởng, chưa làm |
| Tự động lưu + lịch sử 50 phiên bản + khôi phục sau sự cố (SQLite) | 🟢 |
| Đăng nhập Google (PKCE, loopback), token trong Keychain, số dư, lịch sử giao dịch | 🔑 cần `HM_API_URL`, Google Desktop Client ID/Secret (GitHub Secrets) |
| AI Singer: tải bản nhạc, tạo job (idempotent), theo dõi, hủy/hoàn credit | 🔑 cần nhà cung cấp giọng hát tiếng Việt theo nốt; máy chủ khóa tính năng tới khi bật |
| Ký số macOS/Windows, notarization, auto-update | 🔑 cần Apple Developer ID, chứng chỉ Authenticode, khóa updater |
| Verovio, Smart Layout preset, chế độ Continuous/Focus | ⬜ |
| Xuất MP3/FLAC, tách stem | ⬜ (WAV đã có) |
| D.C. / D.S. / Coda khi phát; phát nốt hoa mỹ và láy | ⬜ |
| AI Harmony / AI Lyrics qua provider (tính credit) | ⬜ (bản cục bộ miễn phí đã có) |

## Backend & website
| Hạng mục | Trạng thái |
|---|---|
| Migrations MySQL đầy đủ, ràng buộc không âm, sổ cái có truy vết | ✅ |
| Xác minh Google ID token RS256, phiên băm SHA-256, CSRF cookie, rate limit | ✅ unit test |
| Ví credit idempotent + FOR UPDATE, 100 credit một lần, hoàn credit một lần | ✅ code · ⬜ chưa chạy test DB (cần MySQL) |
| PayOS / VNPay / MoMo: ký + xác minh, webhook idempotent | ✅ unit test · 🔑 cần merchant sandbox |
| AI job queue (SKIP LOCKED, lease, retry), bật theo loại, upload input, tải output | ✅ code · ⬜ test DB |
| API quản trị + trang quản trị (KPI, biểu đồ, đơn hàng, thanh toán lỗi, jobs, lỗi, chỉnh credit có audit, gói/giá, đăng release) | ✅ code · ⬜ thử với dữ liệu thật |
| Website: trang chủ có animation, tải về (OS, SHA-256), bảng giá, FAQ, tài khoản + Google One Tap, SEO/OG/sitemap | ✅ chạy thử với PHP |
| AI worker Python + adapter SVS | ✅ code · 🔑 cần provider |
| Tài liệu: ARCHITECTURE, IMPLEMENTATION_PLAN, LICENSING, DEPLOYMENT (kèm checklist bảo mật), API | ✅ |

## Việc của chủ dự án để có bản phát hành hoàn chỉnh
1. Thuê hosting PHP/MySQL + tên miền, triển khai theo `docs/DEPLOYMENT.md`.
2. Tạo OAuth Client (Web + Desktop) trên Google Cloud; khai báo GitHub Secrets `HM_API_URL`, `HM_GOOGLE_DESKTOP_CLIENT_ID`, `HM_GOOGLE_DESKTOP_CLIENT_SECRET`.
3. Đăng ký merchant PayOS (VietQR) và/hoặc VNPay, MoMo; thử trên sandbox.
4. Chọn nhà cung cấp giọng hát AI tiếng Việt theo nốt (hoặc huấn luyện DiffSinger với dữ liệu ca sĩ có hợp đồng).
5. Mua Apple Developer ID và chứng chỉ ký mã Windows.
6. Quyết định pháp lý về Audiveris (AGPL) nếu muốn đóng gói kèm thay vì người dùng tự cài.
