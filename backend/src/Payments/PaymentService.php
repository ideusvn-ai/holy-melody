<?php
declare(strict_types=1);

namespace HolyMelody\Payments;

use HolyMelody\ApiException;
use HolyMelody\Db;
use HolyMelody\Wallet\WalletService;

/**
 * Luồng: chọn gói → tạo order (chốt giá) → cổng thanh toán → webhook/IPN
 * → xác minh chữ ký + số tiền + đơn hàng → cộng credit ĐÚNG MỘT LẦN.
 * Không bao giờ cộng credit từ callback phía client (returnUrl chỉ để hiển thị).
 */
final class PaymentService
{
    private const ORDER_TTL_MINUTES = 30;

    /** @param array<string,PaymentGateway> $gateways */
    public function __construct(
        private readonly Db $db,
        private readonly WalletService $wallet,
        private readonly array $gateways,
        private readonly string $returnUrl,
        private readonly string $cancelUrl,
    ) {
    }

    /** @return list<array<string,mixed>> */
    public function packages(): array
    {
        return $this->db->all('SELECT id, code, name, credits, price_vnd FROM credit_packages WHERE active = 1 ORDER BY sort_order, id');
    }

    /** @return array<string,mixed> */
    public function createOrder(int $userId, int $packageId, string $gatewayName, string $idempotencyKey): array
    {
        $gw = $this->gateways[$gatewayName] ?? null;
        if (!$gw) {
            throw new ApiException(400, 'GATEWAY_UNAVAILABLE', 'Cổng thanh toán chưa được cấu hình');
        }
        $existing = $this->db->one('SELECT * FROM payment_orders WHERE user_id = ? AND idempotency_key = ?', [$userId, $idempotencyKey]);
        if ($existing) {
            return self::publicOrder($existing);
        }
        $pkg = $this->db->one('SELECT id, credits, price_vnd, name FROM credit_packages WHERE id = ? AND active = 1', [$packageId]);
        if (!$pkg) {
            throw new ApiException(404, 'PACKAGE_NOT_FOUND', 'Gói không tồn tại');
        }
        // mã thanh toán do cổng sinh (SePay: tiền tố + id + số ngẫu nhiên), ghi sau khi có id tự tăng
        $orderId = $this->db->tx(function (Db $db) use ($userId, $pkg, $gw, $idempotencyKey) {
            $db->exec(
                'INSERT INTO payment_orders (user_id, package_id, amount_vnd, credits, status, gateway, gateway_order_id, idempotency_key, expires_at)
                 VALUES (?, ?, ?, ?, \'pending\', ?, UUID(), ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MINUTE))',
                [$userId, (int) $pkg['id'], (int) $pkg['price_vnd'], (int) $pkg['credits'], $gw->name(), $idempotencyKey, self::ORDER_TTL_MINUTES],
            );
            $id = $db->lastId();
            $db->exec('UPDATE payment_orders SET gateway_order_id = ? WHERE id = ?', [$gw->orderCode($id), $id]);
            return $id;
        });
        $order = $this->db->one('SELECT * FROM payment_orders WHERE id = ?', [$orderId]);
        $co = $gw->createCheckout((string) $order['gateway_order_id'], (int) $order['amount_vnd'], (string) $order['gateway_order_id'], $this->returnUrl, $this->cancelUrl);
        $this->db->exec('UPDATE payment_orders SET checkout_url = ? WHERE id = ?', [$co['checkout_url'], $orderId]);
        $order['checkout_url'] = $co['checkout_url'];
        return self::publicOrder($order);
    }

    /**
     * Thông tin trang thanh toán (công khai theo mã thanh toán khó đoán): QR, người nhận, số tiền, trạng thái.
     * Không có thông tin người mua.
     * @return array<string,mixed>|null
     */
    public function payPage(string $code): ?array
    {
        $o = $this->db->one('SELECT * FROM payment_orders WHERE gateway_order_id = ?', [strtoupper($code)]);
        $gw = $o ? ($this->gateways[$o['gateway']] ?? null) : null;
        if (!$o || !$gw instanceof SePayGateway) {
            return null;
        }
        return [
            'code' => $o['gateway_order_id'], 'status' => $o['status'], 'amount_vnd' => (int) $o['amount_vnd'], 'credits' => (int) $o['credits'],
            'qr_url' => $gw->qrUrl((int) $o['amount_vnd'], (string) $o['gateway_order_id']), 'expires_at' => $o['expires_at'], 'paid_at' => $o['paid_at'],
        ] + $gw->beneficiary();
    }

    /**
     * Xử lý webhook/IPN. Idempotent: gửi lặp nhiều lần chỉ cộng credit một lần.
     * @return array{status:string, order_id:?int}
     */
    public function handleNotification(string $gatewayName, array $input, string $rawBody = '', array $headers = []): array
    {
        $gw = $this->gateways[$gatewayName] ?? throw new ApiException(404, 'GATEWAY_UNAVAILABLE', 'Cổng không tồn tại');
        $n = $gw->parseNotification($input, $rawBody, $headers);
        $payload = json_encode($input, JSON_UNESCAPED_UNICODE) ?: '{}';

        return $this->db->tx(function (Db $db) use ($gw, $n, $payload) {
            $order = $n->gatewayOrderId !== ''
                ? $db->one('SELECT * FROM payment_orders WHERE gateway = ? AND gateway_order_id = ? FOR UPDATE', [$gw->name(), $n->gatewayOrderId])
                : null;
            $status = match (true) {
                !$n->signatureValid => 'invalid_signature',
                !$order => 'unknown_order',
                !$n->success => 'not_success',
                // chuyển thiếu → không cộng (admin xử lý); chuyển dư → vẫn cộng gói, số tiền thật ghi trong audit log
                $n->amountVnd < (int) $order['amount_vnd'] => 'amount_mismatch',
                $order['status'] === 'paid' => 'duplicate',
                default => 'valid',
            };
            // Lưu sự kiện; nếu đã nhận đúng sự kiện này rồi → duplicate, không làm gì thêm
            try {
                $db->exec(
                    'INSERT INTO payment_events (payment_order_id, gateway, gateway_event_id, payload, verification_status) VALUES (?, ?, ?, ?, ?)',
                    [$order ? (int) $order['id'] : null, $gw->name(), mb_substr($n->eventId . ($status === 'valid' || $status === 'duplicate' ? '' : ':' . bin2hex(random_bytes(6))), 0, 191), $payload, $status],
                );
            } catch (\mysqli_sql_exception $e) {
                if (!Db::isDuplicate($e)) {
                    throw $e;
                }
                return ['status' => 'duplicate', 'order_id' => $order ? (int) $order['id'] : null];
            }
            if ($status !== 'valid') {
                if ($status === 'not_success' && $order && $order['status'] === 'pending') {
                    $db->exec('UPDATE payment_orders SET status = \'failed\' WHERE id = ? AND status = \'pending\'', [(int) $order['id']]);
                }
                return ['status' => $status, 'order_id' => $order ? (int) $order['id'] : null];
            }
            // Chuyển trạng thái có điều kiện (pending/expired/failed → paid): chỉ một luồng thắng
            $changed = $db->exec(
                'UPDATE payment_orders SET status = \'paid\', paid_at = CURRENT_TIMESTAMP(3), gateway_transaction_id = ?
                 WHERE id = ? AND status IN (\'pending\', \'expired\', \'failed\')',
                [$n->transactionId ?: null, (int) $order['id']],
            );
            if ($changed !== 1) {
                return ['status' => 'duplicate', 'order_id' => (int) $order['id']];
            }
            $this->wallet->apply(
                (int) $order['user_id'], (int) $order['credits'], 'purchase', 'payment_order', (int) $order['id'],
                'payment:' . $order['id'], "Nạp {$order['credits']} credit qua {$gw->name()}",
            );
            $db->exec(
                'INSERT INTO audit_logs (actor_type, action, target_type, target_id, details) VALUES (\'gateway\', \'payment.paid\', \'payment_order\', ?, ?)',
                [(int) $order['id'], json_encode(['gateway' => $gw->name(), 'tx' => $n->transactionId, 'amount' => $n->amountVnd])],
            );
            return ['status' => 'valid', 'order_id' => (int) $order['id']];
        });
    }

    /** @return array<string,mixed>|null */
    public function orderStatus(int $userId, int $orderId): ?array
    {
        $o = $this->db->one('SELECT * FROM payment_orders WHERE id = ? AND user_id = ?', [$orderId, $userId]);
        return $o ? self::publicOrder($o) : null;
    }

    /** @param array<string,mixed> $o @return array<string,mixed> */
    private static function publicOrder(array $o): array
    {
        return [
            'id' => (int) $o['id'], 'status' => $o['status'], 'gateway' => $o['gateway'], 'amount_vnd' => (int) $o['amount_vnd'],
            'credits' => (int) $o['credits'], 'checkout_url' => $o['checkout_url'], 'created_at' => $o['created_at'] ?? null,
            'expires_at' => $o['expires_at'] ?? null, 'paid_at' => $o['paid_at'] ?? null,
        ];
    }
}
