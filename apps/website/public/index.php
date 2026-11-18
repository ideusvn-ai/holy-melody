<?php
declare(strict_types=1);

/**
 * Website Holy Melody + API trong cùng một thư mục gốc (phù hợp shared hosting):
 *   /api/*        → backend REST API
 *   /, /download, /pricing, /faq, /account, /admin, /sitemap.xml, /robots.txt → trang
 */
// php -S (chạy thử cục bộ): để server tự trả file tĩnh
if (PHP_SAPI === 'cli-server' && is_file(__DIR__ . parse_url((string) $_SERVER['REQUEST_URI'], PHP_URL_PATH))) {
    return false;
}
// Thư mục chứa backend/: cấu trúc mã nguồn (apps/website/public), hoặc hosting không đổi được document root
// (nội dung public/ chép vào public_html, phần còn lại ở ~/holymelody, ngoài public_html)
$root = null;
foreach ([dirname(__DIR__, 3), dirname(__DIR__) . '/holymelody', dirname(__DIR__, 2) . '/holymelody', __DIR__ . '/../holymelody'] as $cand) {
    if (is_file($cand . '/backend/src/bootstrap.php')) {
        $root = $cand;
        break;
    }
}
if ($root === null) {
    http_response_code(500);
    exit('Holy Melody: không tìm thấy thư mục holymelody/backend. Xem HUONG-DAN-CAI-DAT.md.');
}
require $root . '/backend/src/bootstrap.php';

use HolyMelody\{App, Config, Db, ApiException};
use HolyMelody\Http\{Request, Response};

$config = Config::load($root . '/backend/.env');
$path = rtrim(parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/', '/') ?: '/';

$db = null;
$dbError = null;
try {
    $db = Db::connect($config);
} catch (\Throwable $e) {
    $dbError = $e;
    error_log('[holy-melody] DB: ' . $e->getMessage());
}

// Trang kiểm tra cài đặt (chỉ hiện Đạt/Chưa, không lộ giá trị cấu hình). Tắt bằng HM_INSTALL_CHECK=0 sau khi xong.
if ($path === '/kiem-tra-cai-dat' && $config->get('HM_INSTALL_CHECK', '1') !== '0') {
    require $root . '/apps/website/app/install_check.php';
    install_check($root, $config, $db, $dbError);
    exit;
}

if (str_starts_with($path, '/api/')) {
    if (!$db) {
        Response::error(new ApiException(503, 'DB_UNAVAILABLE', 'Dịch vụ tạm thời không khả dụng'))->send();
        exit;
    }
    (new App($config, $db))->handle(Request::fromGlobals())->send();
    exit;
}

require $root . '/apps/website/app/pages.php';
render_page($path, $config, $db);
