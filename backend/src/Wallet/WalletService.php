<?php
declare(strict_types=1);

namespace HolyMelody\Wallet;

use HolyMelody\ApiException;
use HolyMelody\Db;
use HolyMelody\InsufficientCreditsException;

/**
 * Mọi thay đổi số dư đi qua apply():
 *   1. SELECT … FOR UPDATE khóa hàng ví (chống race condition / double-spending)
 *   2. kiểm tra idempotency_key đã tồn tại → trả lại kết quả cũ, không áp dụng lần hai
 *   3. kiểm tra không âm
 *   4. UPDATE ví + INSERT sổ cái trong cùng transaction
 * UNIQUE(idempotency_key) và UNIQUE(reference_type, reference_id, type) là lớp chặn cuối ở DB.
 */
final class WalletService
{
    public const TYPES = ['signup_bonus', 'purchase', 'ai_charge', 'ai_refund', 'admin_adjustment', 'reversal', 'omr_charge'];

    public function __construct(private readonly Db $db)
    {
    }

    /** @return bool true nếu vừa tạo ví mới */
    public function ensureWallet(int $userId): bool
    {
        return $this->db->exec('INSERT IGNORE INTO wallets (user_id, balance) VALUES (?, 0)', [$userId]) === 1;
    }

    public function balance(int $userId): int
    {
        $r = $this->db->one('SELECT balance FROM wallets WHERE user_id = ?', [$userId]);
        return $r ? (int) $r['balance'] : 0;
    }

    /**
     * @return array{transaction_id:int, balance_after:int, applied:bool}
     *   applied=false nghĩa là giao dịch đã tồn tại từ trước (retry), không trừ/cộng thêm.
     */
    public function apply(int $userId, int $amount, string $type, string $refType, int $refId, string $idempotencyKey, ?string $note = null): array
    {
        if ($amount === 0) {
            throw new ApiException(400, 'INVALID_AMOUNT', 'Số credit phải khác 0');
        }
        if (!in_array($type, self::TYPES, true)) {
            throw new \InvalidArgumentException("Loại giao dịch không hợp lệ: $type");
        }
        if ($idempotencyKey === '' || strlen($idempotencyKey) > 191) {
            throw new ApiException(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency key không hợp lệ');
        }
        return $this->db->tx(function (Db $db) use ($userId, $amount, $type, $refType, $refId, $idempotencyKey, $note) {
            $w = $db->one('SELECT id, balance FROM wallets WHERE user_id = ? FOR UPDATE', [$userId]);
            if (!$w) {
                throw new ApiException(404, 'WALLET_NOT_FOUND', 'Không tìm thấy ví');
            }
            $existing = $db->one('SELECT id, user_id, amount, balance_after FROM credit_transactions WHERE idempotency_key = ?', [$idempotencyKey])
                ?? $db->one('SELECT id, user_id, amount, balance_after FROM credit_transactions WHERE reference_type = ? AND reference_id = ? AND type = ?', [$refType, $refId, $type]);
            if ($existing) {
                if ((int) $existing['user_id'] !== $userId || (int) $existing['amount'] !== $amount) {
                    throw new ApiException(409, 'IDEMPOTENCY_CONFLICT', 'Khóa idempotency đã dùng cho giao dịch khác');
                }
                return ['transaction_id' => (int) $existing['id'], 'balance_after' => (int) $w['balance'], 'applied' => false];
            }
            $before = (int) $w['balance'];
            $after = $before + $amount;
            if ($after < 0) {
                throw new InsufficientCreditsException($before, -$amount);
            }
            $db->exec('UPDATE wallets SET balance = ? WHERE id = ?', [$after, (int) $w['id']]);
            $db->exec(
                'INSERT INTO credit_transactions (user_id, wallet_id, amount, balance_before, balance_after, type, reference_type, reference_id, idempotency_key, note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$userId, (int) $w['id'], $amount, $before, $after, $type, $refType, $refId, $idempotencyKey, $note],
            );
            return ['transaction_id' => $db->lastId(), 'balance_after' => $after, 'applied' => true];
        });
    }

    /** @return list<array<string,mixed>> */
    public function history(int $userId, int $limit = 50, ?int $beforeId = null): array
    {
        $limit = max(1, min(200, $limit));
        return $this->db->all(
            'SELECT id, amount, balance_before, balance_after, type, reference_type, reference_id, note, created_at
             FROM credit_transactions WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
            [$userId, $beforeId ?? PHP_INT_MAX, $limit],
        );
    }
}
