# Holy Melody — Kiến trúc hệ thống

> Phiên bản tài liệu: 0.1 (Phase 1) · Cập nhật: 2026-11-17

Holy Melody là phần mềm desktop (macOS + Windows) gồm ba khu vực **Sheet Player**, **Score Editor**, **AI Singer Studio**, đi kèm backend PHP/MySQL cho tài khoản, credit, thanh toán và website công khai.

---

## 1. Sơ đồ tổng thể

```text
┌──────────────────────────── Desktop (Tauri 2) ─────────────────────────────┐
│  React + TS UI (WebView)                                                    │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────┐                            │
│  │  PLAYER  │  │ SCORE EDITOR │  │  AI SINGER  │   ← chỉ là các "view"      │
│  └────┬─────┘  └──────┬───────┘  └──────┬──────┘                            │
│       └───────────────┼─────────────────┘                                   │
│                ┌──────▼───────┐   Zustand store: projectStore               │
│                │ ScoreDocument│   (Canonical Score Model + CommandHistory)  │
│                └──────┬───────┘                                             │
│     ┌─────────────────┼────────────────────┬───────────────────┐            │
│  Renderer adapter  Playback adapter   IO adapters          AI adapter       │
│  (Verovio WASM)    (timeline → Rust)  (MusicXML/MIDI/PDF)  (ai-provider-sdk)│
│─────────────────────────── Tauri IPC (commands + events) ───────────────────│
│  Rust core (src-tauri)                                                      │
│  • audio_engine: rustysynth + cpal, chạy trên audio thread riêng            │
│  • audio clock → phát event `playback://position` (tick, sampleTime)        │
│  • project_store: SQLite (rusqlite) – dự án, autosave, version history      │
│  • omr_runner: chạy OMR engine như tiến trình con (sidecar)                 │
│  • auth: OAuth 2.0 Authorization Code + PKCE qua trình duyệt hệ thống       │
└─────────────────────────────────────────┬───────────────────────────────────┘
                                          │ HTTPS JSON (Bearer session token)
┌─────────────────────────────────────────▼───────────────────────────────────┐
│  Backend PHP 8.3 (shared hosting được)                                      │
│  REST API · Google ID token verify · Wallet · Payment webhooks · Admin      │
│  MySQL/MariaDB (InnoDB, REPEATABLE READ, SELECT … FOR UPDATE)               │
└───────────────┬───────────────────────────────────────────┬─────────────────┘
                │ job queue (bảng ai_jobs, polling/lease)   │ webhook
        ┌───────▼────────┐                          ┌───────▼────────┐
        │  AI Worker     │  (máy riêng, GPU nếu cần)│ VNPay / MoMo / │
        │  services/     │  SVS, harmony, mixing    │ PayOS (VietQR) │
        └────────────────┘                          └────────────────┘
```

## 2. Nguyên tắc cốt lõi

1. **Một nguồn sự thật**: `Canonical Score Model` (package `@holy-melody/music-core`). Ba tab đọc/ghi cùng một `ScoreDocument` trong `projectStore`. Không có bản sao bản nhạc riêng cho từng tab.
2. **ID ổn định**: mọi phần tử (part, staff, measure, voice, event, note, lyric, chord symbol) có ID dạng `n_xxxxxxxx` sinh một lần, không đổi khi sửa. ID được ghi xuống MusicXML (thuộc tính `id`) và vào sự kiện MIDI timeline, nên renderer, player, editor và AI đều tham chiếu cùng ID.
3. **Mọi thay đổi đi qua Command**: editor không sửa model trực tiếp; mọi thao tác là `Command` có `apply/invert`, đẩy vào `CommandHistory` → undo/redo nhiều cấp, autosave, đồng bộ tab nhờ một luồng sự kiện `score:changed { revision, affectedMeasureIds }`.
4. **Tác vụ nặng ngoài UI thread**: tổng hợp âm thanh, OMR, xuất WAV, layout PDF chạy ở Rust thread / sidecar / Web Worker.
5. **Offline-first**: mở, soạn, phát MIDI, xuất MusicXML/MIDI không cần mạng hay đăng nhập. Chỉ AI và đồng bộ tài khoản cần Internet.
6. **Tiền tệ chỉ trên server**: desktop không bao giờ tính hay ghi số dư; nó chỉ hiển thị số dư server trả về.
7. **Không giả lập thành công**: tính năng phụ thuộc API key/chứng chỉ chưa có phải báo `NOT_CONFIGURED`, không trả kết quả mock trong luồng production.

## 3. Canonical Score Model

```text
ScoreDocument
├─ id, revision, meta {title, subtitle, composer, lyricist, arranger, copyright}
├─ divisions (ticks per quarter = 480)
├─ tempoMap[]      {tick, bpm, beatUnit}
├─ keyMap[]        {measureIndex, fifths, mode}
├─ timeSigMap[]    {measureIndex, beats, beatType}
├─ parts[]         {id, name, abbreviation, instrument{program, channel, transpose}, staves[]}
│   └─ staves[]    {id, clef}
├─ measures[]      {id, index, number, pickup, barline, repeatStart/End, volta, breaks}
│   └─ (nội dung đo theo part) content[partId] → voices[]
│        └─ voice {id, staffId, events[]}
│             └─ event: NoteEvent | RestEvent (id, duration{type,dots,tuplet}, notes[], lyrics[], ties, slurs, articulations)
├─ chordSymbols[]  {id, measureId, offsetTicks, root, quality, bass}
├─ dynamics[]      {id, measureId, partId, offsetTicks, mark}
├─ layout          {pageSize, orientation, margins, staffSize, preset, ...}
├─ playback        {soundfont, mixer per part}
└─ aiMeta          {lastHarmonyJobId, singerTakes[]}
```

Thời gian lưu bằng **tick nguyên** (480/quarter) – không dùng số thực, tránh sai số làm lệch highlight. Tuplet được biểu diễn bằng tỉ lệ `actual:normal`; độ phân giải là **480 tick/quarter** (chuẩn MIDI phổ biến, chia hết cho 2, 3, 4, 5, 6, 8, 10, 12, 16). Với tuplet không chia hết (ví dụ 7 nốt), phần dư được phân bổ cho các nốt đầu nhóm để tổng nhóm luôn đúng.

### Adapters

| Adapter | Hướng | Trạng thái |
|---|---|---|
| MusicXML → Score | import | Phase 1 (partwise, cơ bản) |
| Score → MusicXML | export | Phase 1 |
| Score → MIDI (SMF type 1) | export | Phase 1 |
| MIDI → Score | import (quantize) | Phase 1 cơ bản, Phase 2 hoàn thiện |
| Score → Playback timeline | nội bộ | Phase 1 (mỗi sự kiện mang noteId) |
| Score → Renderer (Verovio) | qua MusicXML có `xml:id` | Phase 2 |
| Score → PDF | Verovio SVG → PDF vector (Rust `svg2pdf`) | Phase 3 |
| Score → AI Singer | MusicXML + lyrics JSON | Phase 5 |
| OMR → Score | MusicXML từ engine + confidence map | Phase 4 |

## 4. Lựa chọn công nghệ theo module

| Module | Lựa chọn | Lý do / ghi chú |
|---|---|---|
| Desktop shell | **Tauri 2**, React 19, TS, Vite, Tailwind, shadcn/ui, Motion, Zustand | Nhẹ hơn Electron, Rust cho audio/IO |
| Hiển thị ký âm | **Verovio** (WASM) làm renderer chính | Xuất SVG có giữ ID phần tử → highlight & click-to-select chính xác; dàn trang trang/hệ thống tốt. LGPL-3.0 → dùng bản WASM tách riêng, có thể thay thế |
| Hiển thị phụ | OpenSheetMusicDisplay (BSD-3) | Dự phòng cho MusicXML phức tạp |
| Nhập liệu tương tác | Tự viết lớp tương tác trên SVG Verovio (hit-test theo ID + bounding box); VexFlow (MIT) cho preview nốt "ghost" khi đang nhập | Verovio không phải editor; ta giữ model, re-render theo hệ thống bị ảnh hưởng |
| Phân tích hòa âm | Bộ phân tích TS trong music-core (key/scale/chord function) + **music21** (BSD) trong AI worker | music21 là Python → không nhúng vào desktop |
| Synth | **rustysynth** (MIT, Rust thuần) + **cpal** | Không cần build FluidSynth native cho 3 nền tảng; FluidSynth (LGPL-2.1) giữ làm phương án thay thế qua trait `Synth` |
| SoundFont mặc định | GeneralUser GS hoặc FluidR3_GM | Cần xác minh giấy phép phân phối trước khi đóng gói |
| OMR | Trait `OmrEngine`; engine 1: **Audiveris** (AGPL-3.0, Java) chạy như tiến trình riêng do người dùng cài/tải riêng; engine 2: mô hình ML (oemer / homr / SMT) trong worker | Xem rủi ro giấy phép |
| PDF có cấu trúc | pdf.js để phát hiện PDF có text/vector vs ảnh quét; MusicXML nhúng (nếu PDF đính kèm .musicxml) | Không giả định PDF nào cũng trích được MusicXML |
| Lưu dự án | SQLite (rusqlite, bundled) + file `.holymelody` (zip: score.json + assets) | |
| Backend | PHP 8.3, MySQLi prepared statements, không framework (chạy shared hosting) | |
| Đăng nhập | Google Identity Services (web), OAuth 2.0 Code + PKCE + loopback (desktop) | |
| Thanh toán | Adapter `PaymentGateway`: **PayOS** (VietQR có đối soát), **VNPay**, **MoMo** | |
| AI Singer (Strict Melody) | Adapter `SingingSynthProvider` nhận score + lyrics theo nốt (score-conditioned SVS) | Xem rủi ro R3 |
| Nhạc đệm | Sinh **MIDI arrangement** (ràng buộc theo hợp âm + giai điệu) rồi render bằng synth/sample library | Giữ melody tuyệt đối; không dùng text-to-music cho Strict mode |

## 4b. Trợ giúp soạn nhạc (chỉ gợi ý, không tự sửa)

| Module | Vai trò |
|---|---|
| `music-core/advisor.ts` | Trợ lý soạn nhạc: quy tắc giai điệu, phối bè SATB, âm vực, cấu trúc thánh ca, dấu thanh tiếng Việt ↔ hướng giai điệu. Mỗi gợi ý có id ổn định (rule + note ids) để bỏ qua; trạng thái lưu ở `score.advisor`, không nằm trong Undo |
| `music-core/harmony.ts` | Hợp âm thông minh cục bộ: chia đoạn theo phách, chấm điểm hợp âm theo nốt giai điệu, Viterbi với điểm chuyển T→S→D→T và cadence. Trả `HarmonyVariant[]`; AI Harmony (Phase 5) trả cùng định dạng |
| `music-core/lyrics.ts` | Lời ca thông minh: tách âm tiết, phân bổ vào nốt (bỏ qua nối/luyến), nhiều phiên khúc, kiểu chữ/vị trí lời |
| `music-core/notation.ts` | Lệnh ký âm: liên, hợp âm ba, nối, luyến, láy, nốt hoa mỹ, dấu diễn tấu, cường độ, dấu lặp, hóa biểu, số chỉ nhịp |

## 5. Đồng bộ phát nhạc ↔ highlight

1. `buildPlaybackTimeline(score)` → mảng sự kiện `{tick, durationTicks, channel, pitch, velocity, noteId, measureId}` đã unroll repeat/volta.
2. Timeline gửi xuống Rust một lần (`playback_load`). Rust giữ con trỏ theo **số sample đã render** trong callback âm thanh — đó là audio clock thực.
3. Mỗi ~16 ms Rust phát event `playback://position {tick, sampleTime, outputLatency}`. UI nội suy bằng `performance.now()` giữa hai event (chỉ để mượt, luôn hiệu chỉnh lại theo event kế tiếp) và trừ `outputLatency`.
4. UI tra `activeNotesAt(tick)` (interval index đã sắp xếp) → set class `hm-playing` trên `<g id=noteId>` của SVG. Không dùng `setInterval` đếm thời gian độc lập.
5. Đổi tempo/tốc độ: Rust nhân hệ số vào tick-rate → cao độ MIDI không đổi.

## 6. Bảo mật tài khoản, credit, thanh toán

- Định danh người dùng bằng `google_sub`; email chỉ là thuộc tính.
- Desktop: mở trình duyệt hệ thống tới Google với `code_challenge` (S256), lắng nghe `http://127.0.0.1:<port ngẫu nhiên>/callback`, đổi code lấy `id_token`, gửi `id_token` lên `POST /api/v1/auth/google`. Backend xác minh chữ ký RS256 theo JWKS của Google, `iss`, `aud` (danh sách client ID được phép), `exp`, `email_verified`.
- Backend phát **session token ngẫu nhiên 256-bit**, chỉ lưu `SHA-256` của token (`user_sessions.token_hash`). Desktop giữ token trong OS keychain (macOS Keychain / Windows Credential Manager qua plugin `keyring`).
- Credit: mọi thay đổi số dư trong **một transaction** `SELECT balance FROM wallets WHERE user_id=? FOR UPDATE` → kiểm tra → `UPDATE` → `INSERT credit_transactions` (có `balance_before/after`, `idempotency_key` UNIQUE). Số dư là `BIGINT` không âm, có `CHECK (balance >= 0)`.
- AI job: client gửi `Idempotency-Key`; `ai_jobs.idempotency_key` UNIQUE theo user → retry không trừ hai lần. Job lỗi do hệ thống → giao dịch `refund` tham chiếu job, UNIQUE `(reference_type, reference_id, type)` đảm bảo hoàn đúng một lần.
- Thanh toán: chỉ cộng credit trong handler webhook/IPN sau khi xác minh chữ ký HMAC, khớp `amount_vnd`, `order_id`, trạng thái; `payment_events.gateway_event_id` UNIQUE; cập nhật `payment_orders.status` từ `pending→paid` bằng điều kiện `WHERE status='pending'` trong cùng transaction với việc cộng credit.
- Không có secret nào trong desktop (Google desktop client ID/secret theo mô hình "installed app" không được coi là bí mật — Google tài liệu hóa điều này; xác thực thực sự nằm ở PKCE và việc backend verify `id_token`).

## 7. Rủi ro kỹ thuật lớn

| # | Rủi ro | Mức | Biện pháp |
|---|---|---|---|
| R1 | **OMR**: độ chính xác thực tế trên ảnh chụp điện thoại, bản thánh ca cũ, lời tiếng Việt có dấu thấp; Audiveris là AGPL-3.0 → không thể nhúng vào phần mềm thương mại đóng mã mà không tuân thủ AGPL | Cao | Chạy OMR như tiến trình độc lập do người dùng tải riêng (aggregation), hoặc open-source phần tích hợp; xây UI hiệu đính + confidence map là bắt buộc; bộ benchmark nội bộ (fixtures thánh ca VN) đo note-accuracy; OCR lời ca tiếng Việt riêng (Tesseract `vie`) rồi căn vào nốt |
| R2 | **Ký âm tương tác**: Verovio là renderer, không phải editor; re-render toàn bài mỗi phím bấm sẽ chậm với bài nhiều trang | Cao | Re-render theo hệ thống/trang bị ảnh hưởng; layout cache; nhập nốt hiển thị "ghost" ngay bằng overlay rồi mới re-render; đo hiệu năng với fixture 20 trang |
| R3 | **AI hát đúng melody tiếng Việt**: dịch vụ text-to-music (Suno, Udio…) không nhận ràng buộc nốt; SVS có điều kiện theo nốt (DiffSinger/OpenUtau, ACE Studio, Synthesizer V) có rất ít hoặc không có voicebank tiếng Việt thương mại; tiếng Việt có thanh điệu – cao độ thanh điệu xung đột với cao độ nốt | Rất cao | `Strict Melody Mode` chỉ bật khi provider khai báo `supportsScoreConditioning=true`; khả năng thực tế: huấn luyện/thuê voicebank DiffSinger tiếng Việt (cần dữ liệu ca sĩ có hợp đồng); G2P tiếng Việt riêng (âm đầu/vần/thanh); bộ đánh giá đo sai lệch pitch (cents) và onset (ms) so với score. Không quảng cáo tính năng khi chưa đạt ngưỡng |
| R4 | **Bảo mật thanh toán**: QR ngân hàng tĩnh không có xác nhận; webhook giả/lặp; race condition khi trừ credit song song | Cao | Chỉ dùng gateway có webhook ký; idempotency + row lock + UNIQUE; test lặp webhook và trừ song song |
| R5 | **Chi phí AI vs giá 10 credit (10.000đ)**: một bài hát dài với GPU có thể tốn hơn | Trung bình | Bảng `ai_pricing` cấu hình được; có thể tính theo độ dài (credit/phút) khi admin bật |
| R6 | **Ký mã & notarization**: thiếu chứng chỉ Apple Developer ID / Windows code signing → cảnh báo Gatekeeper/SmartScreen | Trung bình | Pipeline sẵn sàng, chỉ bật bước ký khi có secret; ghi rõ trong release là bản chưa ký |
| R7 | **Giấy phép**: Verovio LGPL, MuseScore GPL-3, Audiveris AGPL, SoundFont, font SMuFL (Bravura – OFL) | Trung bình | `docs/LICENSING.md`, kiểm tra trước mỗi release |
| R8 | **Tick & tuplet**: tuplet 5/7 không chia hết 480 | Thấp | Phân bổ phần dư (Bresenham) để tổng ô nhịp chính xác; test |
| R9 | **Google One Tap** không dùng được trong WebView desktop | Thấp | Desktop dùng loopback + PKCE (đã thiết kế) |

## 8. Cấu trúc repository

```text
holy-melody/
├── apps/desktop/          Tauri 2 + React (src/, src-tauri/, tests/)
├── apps/website/          Website PHP (public/, app/, templates/, assets/)
├── packages/
│   ├── music-core/        Canonical Score Model, IO MusicXML/MIDI, transpose, history, timeline
│   ├── shared-types/      Kiểu dùng chung desktop ↔ backend (API DTO)
│   ├── score-renderer/    Adapter Verovio (Phase 2)
│   ├── midi-engine/       Client TS cho Rust audio engine (Phase 2)
│   ├── score-editor/      Logic nhập liệu/selection (Phase 3)
│   ├── omr-adapter/       Interface OMR + Audiveris runner (Phase 4)
│   └── ai-provider-sdk/   Interface provider AI (Phase 5)
├── services/ai-worker/    Worker Python (Phase 5)
├── backend/               PHP API: public/, src/, migrations/, tests/
├── docs/                  ARCHITECTURE, IMPLEMENTATION_PLAN, LICENSING, API
└── TASKS.md
```
