<?php
declare(strict_types=1);

// Front controller cho API. Đặt thư mục public/ làm document root; src/ và .env nằm ngoài web root.
require dirname(__DIR__) . '/src/bootstrap.php';

use HolyMelody\{App, Config, Db};
use HolyMelody\Http\{Request, Response};
use HolyMelody\ApiException;

$config = Config::load(dirname(__DIR__) . '/.env');
try {
    $db = Db::connect($config);
} catch (\Throwable $e) {
    error_log('[holy-melody] DB connect failed: ' . $e->getMessage());
    Response::error(new ApiException(503, 'DB_UNAVAILABLE', 'Dịch vụ tạm thời không khả dụng'))->send();
    exit;
}
(new App($config, $db))->handle(Request::fromGlobals())->send();
