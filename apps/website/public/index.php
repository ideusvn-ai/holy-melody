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
$root = dirname(__DIR__, 3);
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

if (str_starts_with($path, '/api/')) {
    if (!$db) {
        Response::error(new ApiException(503, 'DB_UNAVAILABLE', 'Dịch vụ tạm thời không khả dụng'))->send();
        exit;
    }
    (new App($config, $db))->handle(Request::fromGlobals())->send();
    exit;
}

require __DIR__ . '/../app/pages.php';
render_page($path, $config, $db);
