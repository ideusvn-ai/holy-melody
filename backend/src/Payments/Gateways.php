<?php
declare(strict_types=1);

namespace HolyMelody\Payments;

/**
 * Adapter cổng thanh toán. Mỗi cổng:
 *  - orderCode(): mã đơn gửi cho cổng (với SePay: mã thanh toán nằm trong nội dung chuyển khoản)
 *  - createCheckout(): tạo trang/QR thanh toán
 *  - parseNotification(): xác minh webhook (chữ ký trên THÂN REQUEST THÔ + header) và chuẩn hoá dữ liệu
 */
interface PaymentGateway
{
    public function name(): string;

    public function orderCode(int $orderId): string;

    /** @return array{checkout_url:string, gateway_payload:array<string,mixed>} */
    public function createCheckout(string $gatewayOrderId, int $amountVnd, string $description, string $returnUrl, string $cancelUrl): array;

    /**
     * @param array<string,mixed> $input body JSON đã giải mã; $rawBody + $headers dùng để kiểm chữ ký
     */
    public function parseNotification(array $input, string $rawBody = '', array $headers = []): Notification;
}

final class Notification
{
    public function __construct(
        public readonly bool $signatureValid,
        public readonly bool $success,
        public readonly string $gatewayOrderId,
        public readonly int $amountVnd,
        public readonly string $transactionId,
        /** id sự kiện để chống xử lý lặp */
        public readonly string $eventId,
    ) {
    }
}

/** HTTP POST JSON, có thể thay trong test */
interface HttpClient
{
    /** @param array<string,mixed> $body @param array<string,string> $headers @return array<string,mixed> */
    public function postJson(string $url, array $body, array $headers = []): array;
}

final class CurlHttpClient implements HttpClient
{
    public function postJson(string $url, array $body, array $headers = []): array
    {
        $ch = curl_init($url);
        $h = ['Content-Type: application/json'];
        foreach ($headers as $k => $v) {
            $h[] = "$k: $v";
        }
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($body), CURLOPT_HTTPHEADER => $h,
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_SSL_VERIFYPEER => true]);
        $raw = curl_exec($ch);
        if ($raw === false) {
            throw new \HolyMelody\ApiException(502, 'GATEWAY_UNREACHABLE', 'Không kết nối được cổng thanh toán');
        }
        $d = json_decode((string) $raw, true);
        return is_array($d) ? $d : [];
    }
}

// ============================================================================ SePay (chuyển khoản VietQR + webhook)

/**
 * SePay theo dõi tài khoản ngân hàng của bạn và gửi webhook khi có tiền vào (https://developer.sepay.vn).
 * Khách quét VietQR (qr.sepay.vn) → chuyển khoản với nội dung chứa mã thanh toán → SePay gửi webhook.
 *
 * Xác thực webhook (chọn trong my.sepay.vn → Webhooks → Bảo mật):
 *  - HMAC-SHA256 (khuyên dùng): header X-Sepay-Signature = "sha256=" + hex(HMAC(secret, timestamp + "." + body)),
 *    X-Sepay-Timestamp lệch quá 300 giây bị từ chối (chống phát lại);
 *  - hoặc API Key: header "Authorization: Apikey <KEY>".
 * Chỉ chấp nhận: tiền VÀO, đúng số tài khoản của bạn, đúng mã thanh toán, đúng số tiền (kiểm ở PaymentService).
 */
final class SePayGateway implements PaymentGateway
{
    /** @param \Closure():int|null $clock */
    public function __construct(
        private readonly string $bank,
        private readonly string $accountNumber,
        private readonly string $accountName,
        private readonly string $publicUrl,
        private readonly string $hmacSecret = '',
        private readonly string $apiKey = '',
        private readonly string $prefix = 'HM',
        private readonly ?\Closure $clock = null,
    ) {
    }

    public function name(): string
    {
        return 'sepay';
    }

    /** Mã thanh toán: tiền tố + 6 số id đơn + 4 số ngẫu nhiên (khó đoán), vd HM0000421234 */
    public function orderCode(int $orderId): string
    {
        return strtoupper($this->prefix) . str_pad((string) ($orderId % 1_000_000), 6, '0', STR_PAD_LEFT) . str_pad((string) random_int(0, 9999), 4, '0', STR_PAD_LEFT);
    }

    public function qrUrl(int $amountVnd, string $code): string
    {
        return 'https://qr.sepay.vn/img?' . http_build_query([
            'acc' => $this->accountNumber, 'bank' => $this->bank, 'amount' => $amountVnd, 'des' => $code, 'template' => 'compact',
        ]);
    }

    /** @return array{bank:string, account_number:string, account_name:string} */
    public function beneficiary(): array
    {
        return ['bank' => $this->bank, 'account_number' => $this->accountNumber, 'account_name' => $this->accountName];
    }

    public function createCheckout(string $gatewayOrderId, int $amountVnd, string $description, string $returnUrl, string $cancelUrl): array
    {
        // trang thanh toán của chính website: hiện QR + thông tin chuyển khoản, tự cập nhật khi tiền vào
        return [
            'checkout_url' => rtrim($this->publicUrl, '/') . '/pay/' . rawurlencode($gatewayOrderId),
            'gateway_payload' => ['qr' => $this->qrUrl($amountVnd, $gatewayOrderId)],
        ];
    }

    /** @param array<string,string> $headers tên header viết thường */
    public function verify(string $rawBody, array $headers): bool
    {
        if ($this->hmacSecret !== '') {
            $sig = (string) ($headers['x-sepay-signature'] ?? '');
            $ts = (int) ($headers['x-sepay-timestamp'] ?? 0);
            $now = $this->clock ? ($this->clock)() : time();
            if ($sig === '' || $ts === 0 || abs($now - $ts) > 300) {
                return false;
            }
            $expected = 'sha256=' . hash_hmac('sha256', $ts . '.' . $rawBody, $this->hmacSecret);
            return hash_equals($expected, $sig);
        }
        if ($this->apiKey !== '') {
            $auth = trim((string) ($headers['authorization'] ?? ''));
            return hash_equals('Apikey ' . $this->apiKey, $auth) || hash_equals('Bearer ' . $this->apiKey, $auth);
        }
        return false; // chưa cấu hình xác thực → không bao giờ cộng credit
    }

    /** Mã thanh toán trong giao dịch: trường code (SePay tự nhận diện) hoặc tìm trong nội dung chuyển khoản */
    public function extractCode(array $input): string
    {
        $code = strtoupper(trim((string) ($input['code'] ?? '')));
        $re = '/' . preg_quote(strtoupper($this->prefix), '/') . '\d{10}/';
        if ($code !== '' && preg_match($re, $code)) {
            return $code;
        }
        // ngân hàng có thể viết hoa / bỏ dấu cách / thêm tiền tố vào nội dung
        $content = strtoupper(preg_replace('/\s+/', '', (string) ($input['content'] ?? '') . ' ' . (string) ($input['description'] ?? '')) ?? '');
        return preg_match($re, $content, $m) ? $m[0] : '';
    }

    public function parseNotification(array $input, string $rawBody = '', array $headers = []): Notification
    {
        $valid = $this->verify($rawBody, $headers);
        $account = preg_replace('/\D/', '', (string) ($input['accountNumber'] ?? '')) ?? '';
        $sub = preg_replace('/\W/', '', (string) ($input['subAccount'] ?? '')) ?? '';
        $mine = preg_replace('/\D/', '', $this->accountNumber) ?? '';
        $toMe = $mine !== '' && ($account === $mine || $sub === $mine || ($sub !== '' && $sub === preg_replace('/\W/', '', $this->accountNumber)));
        $in = ($input['transferType'] ?? '') === 'in';
        $id = (string) ($input['id'] ?? '');
        return new Notification(
            signatureValid: $valid,
            success: $in && $toMe,
            gatewayOrderId: $this->extractCode($input),
            amountVnd: (int) round((float) ($input['transferAmount'] ?? 0)),
            transactionId: $id !== '' ? 'sepay-' . $id : '',
            eventId: $id !== '' ? 'sepay:' . $id : 'sepay:' . hash('sha256', $rawBody),
        );
    }
}
