<?php
declare(strict_types=1);

namespace HolyMelody\Ai;

use HolyMelody\ApiException;
use HolyMelody\Db;
use HolyMelody\Wallet\WalletService;

/**
 * Hàng đợi AI job bền vững trong MySQL.
 *  - Tạo job + trừ credit trong CÙNG transaction, idempotent theo (user, Idempotency-Key):
 *    client retry do lỗi mạng sẽ nhận lại job cũ, không bị trừ lần hai.
 *  - Worker lấy job bằng FOR UPDATE SKIP LOCKED + lease; worker tự retry cùng job không tốn credit.
 *  - Job thất bại do hệ thống/provider (refundable) hoặc bị hủy khi đang chờ → hoàn credit đúng một lần.
 */
final class AiJobService
{
    public const TYPES = ['harmony', 'singer', 'lyrics', 'other'];
    private const LEASE_SECONDS = 600;

    /** @param list<string>|null $enabledTypes null = cho phép mọi loại (dùng trong test) */
    public function __construct(private readonly Db $db, private readonly WalletService $wallet, private readonly ?array $enabledTypes = null)
    {
    }

    /** Loại tác vụ có worker/provider thật đang chạy (do quản trị cấu hình) */
    public function isEnabled(string $type): bool
    {
        return $this->enabledTypes === null || in_array($type, $this->enabledTypes, true);
    }

    public function price(string $type): int
    {
        $r = $this->db->one('SELECT credit_cost FROM ai_pricing WHERE job_type = ? AND active = 1', [$type]);
        if (!$r) {
            throw new ApiException(400, 'JOB_TYPE_UNAVAILABLE', 'Loại tác vụ AI không khả dụng');
        }
        return (int) $r['credit_cost'];
    }

    /** @param array<string,mixed> $params @return array<string,mixed> */
    public function create(int $userId, string $type, string $inputReference, array $params, string $idempotencyKey): array
    {
        if (!in_array($type, self::TYPES, true)) {
            throw new ApiException(400, 'INVALID_JOB_TYPE', 'Loại tác vụ không hợp lệ');
        }
        if (!$this->isEnabled($type)) {
            // Không nhận job (và không trừ credit) khi chưa có provider xử lý loại này
            throw new ApiException(503, 'AI_UNAVAILABLE', 'Tính năng AI này chưa được bật trên máy chủ');
        }
        if (!preg_match('/^[A-Za-z0-9_\-]{8,100}$/', $idempotencyKey)) {
            throw new ApiException(400, 'INVALID_IDEMPOTENCY_KEY', 'Thiếu hoặc sai header Idempotency-Key');
        }
        return $this->db->tx(function (Db $db) use ($userId, $type, $inputReference, $params, $idempotencyKey) {
            $existing = $db->one('SELECT * FROM ai_jobs WHERE user_id = ? AND idempotency_key = ?', [$userId, $idempotencyKey]);
            if ($existing) {
                return self::publicJob($existing) + ['replayed' => true];
            }
            $cost = \HolyMelody\Auth\Admins::is($db, $userId) ? 0 : $this->price($type); // admin: không giới hạn credit
            $db->exec(
                'INSERT INTO ai_jobs (user_id, job_type, input_reference, params, status, credit_cost, idempotency_key) VALUES (?, ?, ?, ?, \'pending\', ?, ?)',
                [$userId, $type, $inputReference, json_encode($params, JSON_UNESCAPED_UNICODE), $cost, $idempotencyKey],
            );
            $jobId = $db->lastId();
            if ($cost > 0) {
                // ném InsufficientCreditsException → rollback cả job
                $this->wallet->apply($userId, -$cost, 'ai_charge', 'ai_job', $jobId, "ai_job:$jobId:charge", "AI $type");
            }
            return self::publicJob($db->one('SELECT * FROM ai_jobs WHERE id = ?', [$jobId])) + ['replayed' => false];
        });
    }

    /** Worker lấy một job; trả null nếu hàng đợi trống. @return array<string,mixed>|null */
    public function claim(string $workerId, array $types = self::TYPES): ?array
    {
        return $this->db->tx(function (Db $db) use ($workerId, $types) {
            $in = implode(',', array_fill(0, count($types), '?'));
            $job = $db->one(
                "SELECT * FROM ai_jobs
                 WHERE job_type IN ($in) AND (status = 'pending' OR (status = 'processing' AND lease_until < CURRENT_TIMESTAMP(3)))
                   AND attempts < max_attempts
                 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
                $types,
            );
            if (!$job) {
                return null;
            }
            $db->exec(
                'UPDATE ai_jobs SET status = \'processing\', worker_id = ?, attempts = attempts + 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
                   lease_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND) WHERE id = ?',
                [$workerId, self::LEASE_SECONDS, (int) $job['id']],
            );
            return $db->one('SELECT * FROM ai_jobs WHERE id = ?', [(int) $job['id']]);
        });
    }

    public function progress(int $jobId, string $workerId, int $percent): void
    {
        $this->db->exec(
            'UPDATE ai_jobs SET progress = ?, lease_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND)
             WHERE id = ? AND worker_id = ? AND status = \'processing\'',
            [max(0, min(100, $percent)), self::LEASE_SECONDS, $jobId, $workerId],
        );
    }

    /** @param list<array{kind:string,file_path:string,format:string,bytes?:int,duration?:float,metadata?:array}> $outputs */
    public function complete(int $jobId, string $workerId, string $provider, ?string $providerJobId, array $outputs): void
    {
        $this->db->tx(function (Db $db) use ($jobId, $workerId, $provider, $providerJobId, $outputs) {
            $n = $db->exec(
                'UPDATE ai_jobs SET status = \'completed\', progress = 100, provider = ?, provider_job_id = ?, completed_at = CURRENT_TIMESTAMP(3), lease_until = NULL
                 WHERE id = ? AND worker_id = ? AND status = \'processing\'',
                [$provider, $providerJobId, $jobId, $workerId],
            );
            if ($n !== 1) {
                throw new ApiException(409, 'JOB_NOT_OWNED', 'Job không ở trạng thái xử lý của worker này');
            }
            foreach ($outputs as $o) {
                $db->exec(
                    'INSERT INTO ai_outputs (job_id, kind, file_path, format, bytes, duration, metadata, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY))',
                    [$jobId, $o['kind'], $o['file_path'], $o['format'], $o['bytes'] ?? null, isset($o['duration']) ? (string) $o['duration'] : null, json_encode($o['metadata'] ?? [])],
                );
            }
        });
    }

    /**
     * $retryable: lỗi tạm thời → trả về hàng đợi nếu còn lượt (không trừ thêm credit).
     * $refundable: lỗi do hệ thống/provider → hoàn credit khi job thất bại hẳn.
     */
    public function fail(int $jobId, string $workerId, string $errorCode, string $message, bool $retryable, bool $refundable): string
    {
        return $this->db->tx(function (Db $db) use ($jobId, $workerId, $errorCode, $message, $retryable, $refundable) {
            $job = $db->one('SELECT * FROM ai_jobs WHERE id = ? AND worker_id = ? AND status = \'processing\' FOR UPDATE', [$jobId, $workerId]);
            if (!$job) {
                throw new ApiException(409, 'JOB_NOT_OWNED', 'Job không ở trạng thái xử lý của worker này');
            }
            if ($retryable && (int) $job['attempts'] < (int) $job['max_attempts']) {
                $db->exec('UPDATE ai_jobs SET status = \'pending\', worker_id = NULL, lease_until = NULL, error_code = ?, error_message = ? WHERE id = ?',
                    [$errorCode, mb_substr($message, 0, 1000), $jobId]);
                return 'requeued';
            }
            $db->exec('UPDATE ai_jobs SET status = \'failed\', lease_until = NULL, error_code = ?, error_message = ?, refundable = ?, completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
                [$errorCode, mb_substr($message, 0, 1000), $refundable ? 1 : 0, $jobId]);
            if ($refundable) {
                $this->refund($job);
            }
            return 'failed';
        });
    }

    /** Người dùng hủy: chỉ khi còn chờ → hoàn credit */
    public function cancel(int $userId, int $jobId): array
    {
        return $this->db->tx(function (Db $db) use ($userId, $jobId) {
            $job = $db->one('SELECT * FROM ai_jobs WHERE id = ? AND user_id = ? FOR UPDATE', [$jobId, $userId]);
            if (!$job) {
                throw new ApiException(404, 'JOB_NOT_FOUND', 'Không tìm thấy job');
            }
            if ($job['status'] !== 'pending') {
                throw new ApiException(409, 'JOB_NOT_CANCELLABLE', 'Chỉ hủy được job đang chờ');
            }
            $db->exec('UPDATE ai_jobs SET status = \'cancelled\', completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [$jobId]);
            $this->refund($job);
            return self::publicJob($db->one('SELECT * FROM ai_jobs WHERE id = ?', [$jobId]));
        });
    }

    /** Hoàn credit idempotent: khóa "ai_job:{id}:refund" + UNIQUE(reference, type) */
    private function refund(array $job): void
    {
        $cost = (int) $job['credit_cost'];
        if ($cost <= 0) {
            return;
        }
        $charged = $this->db->one('SELECT id FROM credit_transactions WHERE reference_type = \'ai_job\' AND reference_id = ? AND type = \'ai_charge\'', [(int) $job['id']]);
        if (!$charged) {
            return;
        }
        $this->wallet->apply((int) $job['user_id'], $cost, 'ai_refund', 'ai_job', (int) $job['id'], "ai_job:{$job['id']}:refund", 'Hoàn credit job AI lỗi/hủy');
    }

    /** @return array<string,mixed>|null */
    public function get(int $userId, int $jobId): ?array
    {
        $j = $this->db->one('SELECT * FROM ai_jobs WHERE id = ? AND user_id = ?', [$jobId, $userId]);
        if (!$j) {
            return null;
        }
        $out = self::publicJob($j);
        $out['outputs'] = $this->db->all('SELECT id, kind, format, bytes, duration, created_at, expires_at FROM ai_outputs WHERE job_id = ?', [$jobId]);
        return $out;
    }

    /** @param array<string,mixed> $j @return array<string,mixed> */
    private static function publicJob(array $j): array
    {
        return [
            'id' => (int) $j['id'], 'type' => $j['job_type'], 'status' => $j['status'], 'credit_cost' => (int) $j['credit_cost'],
            'progress' => $j['progress'] !== null ? (int) $j['progress'] : null, 'error' => $j['error_code'] ? ['code' => $j['error_code'], 'message' => $j['error_message']] : null,
            'created_at' => $j['created_at'], 'completed_at' => $j['completed_at'],
        ];
    }
}
