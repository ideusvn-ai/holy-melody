# Triển khai Holy Melody (website + API + AI worker)

## 1. Máy chủ
- PHP 8.3+ với `mysqli`, `openssl`, `curl`, `mbstring`, `intl`
- MySQL 8.0+ hoặc MariaDB 10.6+ (cần `FOR UPDATE SKIP LOCKED`), InnoDB, `utf8mb4`
- HTTPS bắt buộc (Let's Encrypt hoặc của nhà cung cấp hosting)

## 2. Cài đặt (shared hosting)
1. Tải mã nguồn lên, ví dụ `~/holymelody/`.
2. Trỏ **document root** của tên miền tới `apps/website/public/` (thư mục này phục vụ cả website và `/api/*`).
   Không đặt `backend/`, `.env` hay `storage/` trong document root.
3. Tạo CSDL + người dùng riêng, chạy lần lượt `backend/migrations/001_init.sql`, `002_omr_edit.sql`, `003_omr_ai.sql`, `004_sepay.sql`, `005_pricing_openai.sql` (phpMyAdmin → Import). Muốn bật AI (rà soát + đọc lời ca khi chuyển sang Editor, AI Singer): điền `HM_OPENAI_API_KEY` trong `.env`.
4. Sao chép `.env.example` → `backend/.env`, điền:
   - `HM_DB_*`, `HM_PUBLIC_URL`, `HM_CORS_ORIGINS` (thêm `tauri://localhost,http://tauri.localhost` cho app desktop)
   - `HM_GOOGLE_CLIENT_IDS` = Client ID **Web** và **Desktop** (Google Cloud Console → APIs & Services → Credentials)
   - Thông tin SePay `HM_SEPAY_*` (ngân hàng, số tài khoản, secret webhook)
   - `HM_WORKER_TOKEN` (chuỗi ngẫu nhiên ≥ 32 ký tự), `HM_STORAGE_DIR` (ngoài document root, PHP ghi được)
   - `HM_AI_ENABLED_TYPES` để trống cho tới khi worker + nhà cung cấp AI chạy thật
5. Chỉ định quản trị viên: `INSERT INTO admin_users (user_id, role) VALUES (<id>, 'owner');` sau khi người đó đăng nhập lần đầu.

## 3. Google đăng nhập
- **Web client**: Authorized JavaScript origins = `https://<tên-miền>`.
- **Desktop client** (loại "Desktop app"): dùng cho app; khai báo GitHub Secrets
  `HM_API_URL`, `HM_GOOGLE_DESKTOP_CLIENT_ID`, `HM_GOOGLE_DESKTOP_CLIENT_SECRET` để build app có đăng nhập.
  (Google coi secret của ứng dụng desktop là không bí mật; bảo mật dựa trên PKCE + máy chủ xác minh id_token.)

## 4. Thanh toán SePay
Chuyển khoản VietQR (ảnh QR từ `qr.sepay.vn`), xác nhận bằng webhook SePay. Cấu hình chi tiết: `docs/HUONG-DAN-CAI-DAT-WEB.md`, Bước 7.
- Webhook: `https://<tên-miền>/api/v1/webhooks/sepay` (JSON, HMAC-SHA256 hoặc API Key, chỉ tiền vào, chỉ khi có mã thanh toán)
- Cấu trúc mã thanh toán trên my.sepay.vn: tiền tố `HM` + 10 chữ số
- Mọi webhook (kể cả sai chữ ký) được lưu ở bảng `payment_events` để đối soát. SePay khuyên chạy đối soát định kỳ qua API giao dịch nếu website ngừng lâu.

## 5. AI worker
Chạy trên máy riêng (VPS/GPU), không chạy trong PHP:
```bash
HM_API_URL=https://<tên-miền> HM_WORKER_TOKEN=... HM_STORAGE_DIR=/mnt/shared/storage \
HM_SVS_URL=... HM_SVS_KEY=... python3 services/ai-worker/worker.py
```
`HM_STORAGE_DIR` phải là thư mục dùng chung với máy chủ web (NFS/S3 mount). Chỉ khi worker chạy ổn định mới thêm loại job vào `HM_AI_ENABLED_TYPES`.

## 6. Phát hành app
Mỗi lần đẩy lên `main`, GitHub Actions build `.dmg` (Apple Silicon, Intel) và `.exe`/`.msi`, tạo pre-release.
Đăng bản chính thức ở trang Quản trị → "Đăng bản phát hành" (URL tải + SHA-256 lấy từ Release).

## 7. Danh sách kiểm tra bảo mật
- [ ] HTTPS + HSTS; document root chỉ là `apps/website/public`
- [ ] `.env` quyền 600, không nằm trong web root; `HM_WORKER_TOKEN` mạnh
- [ ] Người dùng MySQL chỉ có quyền trên CSDL của app
- [ ] Đã chạy test tích hợp với CSDL thật: `HM_TEST_DB_* php backend/tests/run.php` (7 test DB)
- [ ] Webhook SePay: bật HMAC-SHA256; thử bằng Test mode của SePay (gửi lặp lại chỉ cộng một lần)
- [ ] Sao lưu CSDL hằng ngày; giữ `payment_events`, `audit_logs`, `credit_transactions` tối thiểu 5 năm
- [ ] Theo dõi trang Quản trị → Thanh toán lỗi / Lỗi hệ thống
