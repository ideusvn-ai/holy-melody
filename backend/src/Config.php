<?php
declare(strict_types=1);

namespace HolyMelody;

/** Cấu hình lấy từ biến môi trường hoặc file .env (không commit). Không có secret mặc định. */
final class Config
{
    /** @var array<string,string> */
    private array $values;

    /** @param array<string,string> $values */
    public function __construct(array $values)
    {
        $this->values = $values;
    }

    public static function load(?string $envFile = null): self
    {
        $vals = [];
        if ($envFile && is_file($envFile)) {
            foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
                if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
                    continue;
                }
                [$k, $v] = explode('=', $line, 2);
                $vals[trim($k)] = trim(trim($v), "\"'");
            }
        }
        foreach (getenv() as $k => $v) {
            if (str_starts_with($k, 'HM_')) {
                $vals[$k] = $v;
            }
        }
        return new self($vals);
    }

    public function get(string $key, ?string $default = null): ?string
    {
        $v = $this->values[$key] ?? null;
        return ($v === null || $v === '') ? $default : $v;
    }

    public function require(string $key): string
    {
        $v = $this->get($key);
        if ($v === null) {
            throw new NotConfiguredException("Thiếu cấu hình $key");
        }
        return $v;
    }

    public function int(string $key, int $default): int
    {
        $v = $this->get($key);
        return $v === null ? $default : (int) $v;
    }

    /** @return list<string> */
    public function list(string $key): array
    {
        $v = $this->get($key);
        return $v === null ? [] : array_values(array_filter(array_map('trim', explode(',', $v))));
    }
}
