<?php
declare(strict_types=1);

namespace HolyMelody\Support;

use HolyMelody\ApiException;
use HolyMelody\Db;

/** Giới hạn tần suất theo cửa sổ cố định, lưu trong MySQL (chạy được trên shared hosting). */
final class RateLimiter
{
    public function __construct(private readonly Db $db)
    {
    }

    public function hit(string $bucket, int $limit, int $windowSeconds): void
    {
        $window = intdiv(time(), $windowSeconds) * $windowSeconds;
        $key = substr(hash('sha256', $bucket), 0, 64);
        $this->db->exec(
            'INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE hits = hits + 1',
            [$key, $window],
        );
        $row = $this->db->one('SELECT hits FROM rate_limits WHERE bucket = ? AND window_start = ?', [$key, $window]);
        if ($row && (int) $row['hits'] > $limit) {
            throw new ApiException(429, 'RATE_LIMITED', 'Quá nhiều yêu cầu, vui lòng thử lại sau', ['retry_after' => $window + $windowSeconds - time()]);
        }
        if (random_int(1, 200) === 1) {
            $this->db->exec('DELETE FROM rate_limits WHERE window_start < ?', [time() - 86400]);
        }
    }
}
