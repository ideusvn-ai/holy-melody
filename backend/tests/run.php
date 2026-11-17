<?php
declare(strict_types=1);

/**
 * Trình chạy test tối giản (không cần PHPUnit/Composer).
 *   php backend/tests/run.php
 * Test tích hợp với MySQL chạy khi có HM_TEST_DB_HOST/HM_TEST_DB_NAME/HM_TEST_DB_USER (CSDL sẽ bị xóa!).
 */
require dirname(__DIR__) . '/src/bootstrap.php';

final class T
{
    public static int $pass = 0;
    public static int $fail = 0;
    public static int $skip = 0;

    public static function test(string $name, callable $fn): void
    {
        try {
            $fn();
            self::$pass++;
            echo "  ✔ $name\n";
        } catch (SkipTest $e) {
            self::$skip++;
            echo "  ○ $name (bỏ qua: {$e->getMessage()})\n";
        } catch (\Throwable $e) {
            self::$fail++;
            echo "  ✘ $name\n      " . $e::class . ': ' . $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine() . "\n";
        }
    }
}
final class SkipTest extends \Exception
{
}

function ok(bool $cond, string $msg = 'assertion failed'): void
{
    if (!$cond) {
        throw new \RuntimeException($msg);
    }
}
function eq(mixed $a, mixed $b, string $msg = ''): void
{
    if ($a !== $b) {
        throw new \RuntimeException(($msg ? "$msg: " : '') . 'expected ' . var_export($b, true) . ', got ' . var_export($a, true));
    }
}
function throwsCode(callable $fn, string $code): void
{
    try {
        $fn();
    } catch (\HolyMelody\ApiException $e) {
        eq($e->errorCode, $code);
        return;
    }
    throw new \RuntimeException("expected ApiException $code");
}

foreach (glob(__DIR__ . '/*Test.php') as $f) {
    echo "\n" . basename($f) . "\n";
    require $f;
}
printf("\n%d passed, %d failed, %d skipped\n", T::$pass, T::$fail, T::$skip);
exit(T::$fail > 0 ? 1 : 0);
