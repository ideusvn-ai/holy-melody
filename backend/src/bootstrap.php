<?php
declare(strict_types=1);

/**
 * Autoloader PSR-4 tối giản (không cần Composer → chạy được trên shared hosting).
 * Namespace gốc: HolyMelody\ → backend/src/
 */
spl_autoload_register(static function (string $class): void {
    $prefix = 'HolyMelody\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $path = __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($path)) {
        require $path;
    }
});

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

// Các file chứa nhiều lớp nhỏ liên quan
require_once __DIR__ . '/Exceptions.php';
require_once __DIR__ . '/Http/Http.php';
require_once __DIR__ . '/Payments/Gateways.php';
