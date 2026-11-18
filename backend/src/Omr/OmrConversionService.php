<?php
declare(strict_types=1);

namespace HolyMelody\Omr;

use HolyMelody\Db;
use HolyMelody\ApiException;
use HolyMelody\Wallet\WalletService;

/**
 * Trừ credit (mặc định 50) khi người dùng chuyển một bản nhạc ảnh/PDF sang chế độ biên tập. Admin: miễn phí.
 * Mỗi (người dùng, file gốc) chỉ bị trừ một lần: gọi lại (mất mạng, bấm hai lần, mở lại dự án) trả kết quả cũ.
 */
final class OmrConversionService
{
    public const DEFAULT_COST = 50;

    public function __construct(private Db $db, private WalletService $wallet)
    {
    }

    public function price(): int
    {
        $row = $this->db->one("SELECT credit_cost FROM ai_pricing WHERE job_type = 'omr_edit'");
        return $row ? (int) $row['credit_cost'] : self::DEFAULT_COST;
    }

    /** @return array{conversion_id:int, credits:int, transaction_id:?int, replayed:bool, created_at:string} */
    public function convert(int $userId, string $sourceHash, string $title, int $pages, int $measures): array
    {
        $sourceHash = strtolower($sourceHash);
        if (!preg_match('/^[0-9a-f]{64}$/', $sourceHash)) {
            throw new ApiException(400, 'INVALID_SOURCE_HASH', 'Mã băm file gốc không hợp lệ');
        }
        $title = mb_substr(trim($title), 0, 255);
        return $this->db->tx(function (Db $db) use ($userId, $sourceHash, $title, $pages, $measures) {
            $existing = $db->one('SELECT * FROM omr_conversions WHERE user_id = ? AND source_hash = ? FOR UPDATE', [$userId, $sourceHash]);
            if ($existing) {
                $tx = $db->one("SELECT id FROM credit_transactions WHERE reference_type = 'omr_conversion' AND reference_id = ? AND type = 'omr_charge'", [(int) $existing['id']]);
                return self::out($existing, $tx ? (int) $tx['id'] : null, true);
            }
            // tài khoản quản trị: không trừ credit
            $cost = \HolyMelody\Auth\Admins::is($db, $userId) ? 0 : $this->price();
            $db->exec(
                'INSERT INTO omr_conversions (user_id, source_hash, title, pages, measures, credit_cost) VALUES (?, ?, ?, ?, ?, ?)',
                [$userId, $sourceHash, $title, max(1, $pages), max(0, $measures), $cost],
            );
            $id = $db->lastId();
            $txId = null;
            if ($cost > 0) {
                // InsufficientCreditsException → rollback cả bản ghi chuyển đổi
                $txId = (int) $this->wallet->apply($userId, -$cost, 'omr_charge', 'omr_conversion', $id, "omr_edit:$userId:$sourceHash", 'Chuyển sang Edit: ' . $title)['transaction_id'];
            }
            return self::out($db->one('SELECT * FROM omr_conversions WHERE id = ?', [$id]), $txId, false);
        });
    }

    /** @param array<string,mixed> $row */
    private static function out(array $row, ?int $txId, bool $replayed): array
    {
        return [
            'conversion_id' => (int) $row['id'],
            'credits' => (int) $row['credit_cost'],
            'transaction_id' => $txId,
            'replayed' => $replayed,
            'created_at' => (string) $row['created_at'],
        ];
    }
}
