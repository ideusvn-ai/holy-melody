<?php
declare(strict_types=1);

use HolyMelody\Config;
use HolyMelody\Db;

/** Kiểm tra cài đặt trên hosting: chỉ hiện Đạt / Chưa đạt + cách sửa, không in giá trị bí mật */
function install_check(string $root, Config $config, ?Db $db, ?\Throwable $dbError): void
{
    $rows = [];
    $add = function (string $name, bool $ok, string $fix = '', bool $optional = false) use (&$rows) {
        $rows[] = [$name, $ok, $fix, $optional];
    };
    $add('PHP ≥ 8.3 (đang dùng ' . PHP_VERSION . ')', version_compare(PHP_VERSION, '8.3.0', '>='), 'cPanel → Select PHP Version → chọn 8.3 hoặc mới hơn');
    foreach (['mysqli', 'openssl', 'curl', 'mbstring', 'json', 'simplexml'] as $ext) {
        $add("Tiện ích PHP: $ext", extension_loaded($ext), 'cPanel → Select PHP Version → Extensions → bật ' . $ext);
    }
    $add('Tiện ích PHP: intl (khuyên dùng)', extension_loaded('intl'), 'Bật intl trong Select PHP Version', true);
    $env = $root . '/backend/.env';
    $add('Có file backend/.env', is_file($env), 'Đổi tên backend/.env.example thành backend/.env rồi điền thông tin');
    $add('backend/.env không nằm trong thư mục web công khai', !str_starts_with(realpath($env) ?: $env, realpath($_SERVER['DOCUMENT_ROOT'] ?? '/nonexistent') ?: '/nonexistent'), 'Chuyển thư mục holymelody ra ngoài public_html');
    $add('Kết nối được CSDL MySQL', $db !== null, 'Kiểm tra HM_DB_HOST / HM_DB_NAME / HM_DB_USER / HM_DB_PASS trong .env' . ($dbError ? ' (lỗi: ' . htmlspecialchars(substr($dbError->getMessage(), 0, 80)) . ')' : ''));
    if ($db) {
        $tables = [];
        try {
            foreach ($db->all('SHOW TABLES') as $r) {
                $tables[] = (string) array_values($r)[0];
            }
        } catch (\Throwable) {
        }
        $add('Đã chạy 001_init.sql (bảng users, credit_transactions…)', in_array('users', $tables, true) && in_array('credit_transactions', $tables, true), 'phpMyAdmin → chọn CSDL → Import → holymelody/install.sql');
        $add('Đã chạy 002_omr_edit.sql (bảng omr_conversions)', in_array('omr_conversions', $tables, true), 'Import install.sql (hoặc 002_omr_edit.sql)');
        $add('Đã chạy 003_omr_ai.sql (bảng omr_ai_calls)', in_array('omr_ai_calls', $tables, true), 'Import install.sql (hoặc 003_omr_ai.sql)');
    }
    $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    $add('Đang chạy HTTPS', $https, 'cPanel → SSL/TLS Status → AutoSSL (Let\'s Encrypt) cho tên miền');
    $add('HM_PUBLIC_URL đã điền', (string) $config->get('HM_PUBLIC_URL', '') !== '' && !str_contains((string) $config->get('HM_PUBLIC_URL'), 'holymelody.app'), 'Điền HM_PUBLIC_URL=https://tên-miền-của-bạn');
    $storage = (string) $config->get('HM_STORAGE_DIR', '');
    $add('Thư mục lưu trữ HM_STORAGE_DIR ghi được', $storage !== '' && is_dir($storage) && is_writable($storage), 'Tạo thư mục (vd /home/USER/holymelody/storage), quyền 755, điền đường dẫn tuyệt đối');
    $add('Đăng nhập Google: HM_GOOGLE_CLIENT_IDS', (string) $config->get('HM_GOOGLE_CLIENT_IDS', '') !== '', 'Tạo OAuth Client (Web + Desktop) ở Google Cloud Console rồi điền');
    $acc = (string) $config->get('HM_SEPAY_ACCOUNT_NUMBER', '') !== '' && (string) $config->get('HM_SEPAY_BANK', '') !== '';
    $add('Thanh toán SePay: ngân hàng + số tài khoản (HM_SEPAY_BANK, HM_SEPAY_ACCOUNT_NUMBER)', $acc, 'Điền mã ngân hàng (vd MBBank, Vietcombank — xem qr.sepay.vn/banks.json) và số tài khoản đã liên kết trên my.sepay.vn', true);
    $auth = (string) $config->get('HM_SEPAY_WEBHOOK_SECRET', '') !== '' || (string) $config->get('HM_SEPAY_API_KEY', '') !== '';
    $add('Thanh toán SePay: xác thực webhook (HM_SEPAY_WEBHOOK_SECRET hoặc HM_SEPAY_API_KEY)', !$acc || $auth, 'Bắt buộc khi đã bật SePay: thiếu thì webhook bị từ chối, không cộng credit');
    if ($db) {
        $gw = '';
        try {
            $gw = (string) ($db->one("SHOW COLUMNS FROM payment_orders LIKE 'gateway'")['Type'] ?? '');
        } catch (\Throwable) {
        }
        $add('Đã chạy 004_sepay.sql (cổng sepay)', str_contains($gw, 'sepay'), 'Import install.sql (hoặc 004_sepay.sql)');
    }
    $add('AI đọc ảnh vùng khó: HM_ANTHROPIC_API_KEY', (string) $config->get('HM_ANTHROPIC_API_KEY', '') !== '', 'Không bắt buộc. Có key thì bước Chuyển sang Editor dùng thêm AI', true);
    $add('HM_WORKER_TOKEN đủ mạnh (≥ 32 ký tự)', strlen((string) $config->get('HM_WORKER_TOKEN', '')) >= 32, 'Chỉ cần khi chạy AI worker (AI Singer)', true);

    $okAll = !array_filter($rows, fn ($r) => !$r[1] && !$r[3]);
    header('Content-Type: text/html; charset=utf-8');
    header('X-Robots-Tag: noindex');
    echo '<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kiểm tra cài đặt · Holy Melody</title>';
    echo '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#222}h1{font-size:22px}li{list-style:none;padding:8px 10px;border-bottom:1px solid #eee}.ok{color:#1a7f37}.no{color:#c2410c}.opt{color:#8a6d00}small{display:block;color:#666;margin-left:26px}.b{padding:12px;border-radius:8px;margin:16px 0}.g{background:#e8f6ec}.r{background:#fdeee6}</style>';
    echo '<h1>Kiểm tra cài đặt Holy Melody</h1>';
    echo $okAll ? '<div class="b g">✅ Các mục bắt buộc đã đạt. Sau khi xong, thêm <code>HM_INSTALL_CHECK=0</code> vào .env để tắt trang này.</div>'
        : '<div class="b r">Còn mục bắt buộc chưa đạt — sửa theo hướng dẫn bên dưới rồi tải lại trang.</div>';
    echo '<ul style="padding:0">';
    foreach ($rows as [$name, $ok, $fix, $opt]) {
        $cls = $ok ? 'ok' : ($opt ? 'opt' : 'no');
        $icon = $ok ? '✔' : ($opt ? '○' : '✘');
        echo "<li><span class=\"$cls\">$icon</span> " . htmlspecialchars($name) . ($opt && !$ok ? ' <em>(không bắt buộc)</em>' : '');
        if (!$ok && $fix) {
            echo '<small>' . htmlspecialchars($fix) . '</small>';
        }
        echo '</li>';
    }
    echo '</ul><p><a href="/">← Trang chủ</a> · <a href="/api/v1/health">/api/v1/health</a></p></html>';
}
