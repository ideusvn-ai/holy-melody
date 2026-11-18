# Cài đặt website Holy Melody lên hosting

Gói này gồm **website** (trang chủ, tải app, bảng giá, câu hỏi thường gặp, tài khoản, quản trị) và **API** mà app desktop dùng để đăng nhập, quản lý credit, thanh toán và AI. Cả hai chạy chung một tên miền.

## Yêu cầu hosting
- **PHP 8.3 trở lên**, có các tiện ích `mysqli`, `openssl`, `curl`, `mbstring`, `json`, `simplexml` (nên có thêm `intl`)
- **MySQL 8.0+** hoặc **MariaDB 10.6+**. MariaDB 10.3/10.4 cũ **không chạy được**.
- **SSL (HTTPS)**: hầu hết hosting có AutoSSL / Let's Encrypt miễn phí
- Apache hoặc LiteSpeed (có `.htaccess`), như đa số hosting cPanel/DirectAdmin ở Việt Nam

## Nội dung gói
```
holymelody/
├── apps/website/public/   ← thư mục công khai (index.php, .htaccess, assets/)
├── apps/website/app/      ← mã trang web
├── backend/src/           ← mã API (không được để công khai)
├── backend/.env.example   ← mẫu cấu hình → đổi tên thành .env
├── backend/migrations/    ← từng file SQL (để tham khảo)
├── install.sql            ← toàn bộ CSDL trong 1 file: chỉ cần Import file này
├── storage/               ← nơi lưu file của người dùng (AI)
└── HUONG-DAN-CAI-DAT.md
```

---

## Bước 1: Tạo cơ sở dữ liệu
1. cPanel → **MySQL® Databases** (hoặc *MySQL Database Wizard*).
2. Tạo CSDL, ví dụ `user_holymelody`.
3. Tạo người dùng MySQL với mật khẩu mạnh, rồi **Add User To Database** với quyền **ALL PRIVILEGES**.
4. Ghi lại 3 thông tin: tên CSDL, tên người dùng, mật khẩu.
5. cPanel → **phpMyAdmin** → chọn CSDL vừa tạo → tab **Import** → chọn file `install.sql` → **Go (Thực hiện)**.
   Thành công khi CSDL có khoảng 20 bảng (`users`, `credit_transactions`, `omr_conversions`…).

## Bước 2: Tải mã nguồn lên
Chọn **một** trong hai cách, tuỳ hosting có cho đổi thư mục gốc (document root) của tên miền hay không.

### Cách A (khuyên dùng): tên miền phụ / addon domain, đổi được document root
1. cPanel → **File Manager** → vào thư mục nhà (`/home/USER/`), **ngoài** `public_html`.
2. **Upload** file zip → chuột phải → **Extract**. Bạn sẽ có `/home/USER/holymelody/`.
3. cPanel → **Domains** → tên miền → **Document Root** sửa thành:
   `/home/USER/holymelody/apps/website/public`

### Cách B: tên miền chính, không đổi được document root (`public_html`)
1. Giải nén zip ra `/home/USER/holymelody/`, nằm **cạnh** `public_html` chứ không nằm trong đó.
2. Mở `holymelody/apps/website/public/`, chép **toàn bộ** nội dung (gồm `index.php`, `.htaccess`, thư mục `assets/`) vào `public_html/`.
   - File `.htaccess` bị ẩn: trong File Manager bấm **Settings → Show Hidden Files (dotfiles)**.
3. Kết quả cần có:
   ```
   /home/USER/public_html/index.php
   /home/USER/public_html/.htaccess
   /home/USER/public_html/assets/…
   /home/USER/holymelody/backend/…
   ```
   `index.php` tự tìm thấy thư mục `holymelody` nằm cạnh `public_html`.

> ⚠️ Không đặt cả thư mục `holymelody/` vào trong `public_html`, vì như vậy file cấu hình có mật khẩu sẽ bị lộ ra ngoài.

## Bước 3: Cấu hình `.env`
1. Trong `holymelody/backend/`, đổi tên `.env.example` thành **`.env`** (chuột phải → Rename).
2. Chuột phải → **Edit**, điền các dòng sau (các dòng khác để nguyên):

| Dòng | Điền gì |
|---|---|
| `HM_PUBLIC_URL` | `https://ten-mien-cua-ban.vn` |
| `HM_CORS_ORIGINS` | `https://ten-mien-cua-ban.vn,tauri://localhost,http://tauri.localhost` |
| `HM_DB_HOST` | `localhost` (đa số hosting) |
| `HM_DB_NAME`, `HM_DB_USER`, `HM_DB_PASS` | 3 thông tin ở Bước 1 |
| `HM_STORAGE_DIR` | đường dẫn tuyệt đối, ví dụ `/home/USER/holymelody/storage` |
| `HM_GOOGLE_CLIENT_IDS` | Client ID Google (xem Bước 5), cách nhau bởi dấu phẩy |
| `HM_WORKER_TOKEN` | chuỗi ngẫu nhiên ≥ 32 ký tự (chỉ cần khi chạy AI Singer) |
| `HM_ANTHROPIC_API_KEY` | (không bắt buộc) khoá AI để đọc lại vùng nhận dạng khó khi chuyển sang Editor |
| Khoá **PayOS / VNPay / MoMo** | điền cổng bạn dùng; nên thử bằng khoá **sandbox** trước |

3. Đặt quyền file `.env` là **600** (chuột phải → Change Permissions).

## Bước 4: Bật HTTPS và kiểm tra
1. cPanel → **SSL/TLS Status** → **Run AutoSSL** cho tên miền.
2. cPanel → **Select PHP Version** → chọn **8.3** (hoặc mới hơn) → tab **Extensions** → bật `mysqli`, `curl`, `mbstring`, `intl`.
3. Mở **`https://ten-mien-cua-ban.vn/kiem-tra-cai-dat`**. Trang này liệt kê từng mục **✔ Đạt / ✘ Chưa đạt**, kèm cách sửa, và không hiện mật khẩu hay khoá nào.
4. Khi mọi mục bắt buộc đã ✔, thêm dòng `HM_INSTALL_CHECK=0` vào `.env` để tắt trang kiểm tra.
5. Mở `https://ten-mien-cua-ban.vn/api/v1/health`. Đúng sẽ thấy `{"ok":true,...}`.

## Bước 5: Đăng nhập bằng Google
1. Vào https://console.cloud.google.com → tạo Project → **APIs & Services → OAuth consent screen**, điền tên app và email.
2. **Credentials → Create Credentials → OAuth client ID**:
   - Loại **Web application**: *Authorized JavaScript origins* = `https://ten-mien-cua-ban.vn`
   - Loại **Desktop app**: dùng cho app Holy Melody trên máy tính
3. Điền **cả hai** Client ID vào `HM_GOOGLE_CLIENT_IDS` (cách nhau dấu phẩy).
4. Để bản app desktop đăng nhập được, khai báo trong GitHub → repo `holy-melody` → **Settings → Secrets and variables → Actions**:
   `HM_API_URL` = `https://ten-mien-cua-ban.vn`, `HM_GOOGLE_DESKTOP_CLIENT_ID`, `HM_GOOGLE_DESKTOP_CLIENT_SECRET`.
   Lần build tiếp theo sẽ tự gắn các giá trị này vào app.

## Bước 6: Tài khoản quản trị
1. Đăng nhập website bằng Google một lần.
2. phpMyAdmin → tab **SQL**, chạy lệnh (đổi email cho đúng):
   ```sql
   INSERT INTO admin_users (user_id, role) SELECT id, 'owner' FROM users WHERE email = 'email-cua-ban@gmail.com';
   ```
3. Vào `https://ten-mien-cua-ban.vn/admin` để quản lý người dùng, đơn hàng, gói credit và bản phát hành.

## Bước 7: Thanh toán (khi sẵn sàng)
Khai báo URL nhận thông báo (webhook/IPN) trong trang quản trị của cổng thanh toán:

| Cổng | URL |
|---|---|
| PayOS | `https://ten-mien-cua-ban.vn/api/v1/webhooks/payos` |
| VNPay (IPN) | `https://ten-mien-cua-ban.vn/api/v1/webhooks/vnpay` |
| MoMo | tự gửi kèm khi tạo đơn: `https://ten-mien-cua-ban.vn/api/v1/webhooks/momo` |

Thử trên **sandbox** trước. Credit chỉ được cộng khi chữ ký hợp lệ, đúng số tiền và đúng đơn; mọi thông báo đều được lưu lại để đối soát.

## Bước 8: Đăng bản tải app
Trang **/download** lấy thông tin từ mục **Quản trị → Bản phát hành**. Thêm bản mới với link tải từ GitHub Releases, ví dụ:
`https://github.com/baoitsv-lib/holy-melody/releases/tag/build-16`. Trang Release có sẵn file `.dmg`, `.exe` và `.msi`.

---

## Gặp lỗi thường gặp
| Hiện tượng | Cách xử lý |
|---|---|
| Trang trắng hoặc lỗi 500 | Xem `error_log` trong File Manager; thường do PHP < 8.3 hoặc thiếu tiện ích |
| "không tìm thấy thư mục holymelody/backend" | Thư mục `holymelody` phải nằm **cạnh** `public_html` (Cách B) hoặc document root trỏ đúng (Cách A) |
| `/pricing` hoặc `/api/...` báo 404 | Thiếu file `.htaccess` (bật *Show Hidden Files* rồi chép lại) hoặc hosting tắt mod_rewrite |
| `DB_UNAVAILABLE` | Sai thông tin CSDL trong `.env`, hoặc chưa Add User To Database |
| Lỗi khi Import SQL ở `SKIP LOCKED` | MariaDB quá cũ, cần nhờ nhà cung cấp nâng lên 10.6+ |
| App desktop báo chưa đăng nhập được | Kiểm tra `HM_GOOGLE_CLIENT_IDS` và các GitHub Secrets ở Bước 5, rồi build lại app |
| Website bị chuyển vòng lặp HTTPS | Xoá 4 dòng "bắt buộc HTTPS" trong `.htaccess` (hosting đã tự chuyển) |

**Bảo mật:** sao lưu CSDL hằng ngày (cPanel → Backup), không chia sẻ file `.env`, và đổi `HM_WORKER_TOKEN` nếu nghi bị lộ.
