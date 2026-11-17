<?php
declare(strict_types=1);

namespace HolyMelody\Payments;

/**
 * Adapter cổng thanh toán. Mỗi cổng:
 *  - createCheckout(): tạo yêu cầu thanh toán phía cổng, trả URL/QR
 *  - parseNotification(): xác minh chữ ký webhook/IPN và chuẩn hóa dữ liệu
 * Công thức ký theo tài liệu công khai của từng cổng; PHẢI đối chiếu lại với tài liệu sandbox
 * hiện hành khi tích hợp (Phase 6) vì cổng có thể đổi phiên bản API.
 */
interface PaymentGateway
{
    public function name(): string;

    /** @return array{checkout_url:string, gateway_payload:array<string,mixed>} */
    public function createCheckout(string $gatewayOrderId, int $amountVnd, string $description, string $returnUrl, string $cancelUrl): array;

    /**
     * @param array<string,mixed>|array<string,string> $input body JSON (PayOS, MoMo) hoặc query (VNPay)
     */
    public function parseNotification(array $input): Notification;
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

// ============================================================================ PayOS (VietQR có đối soát)

final class PayOsGateway implements PaymentGateway
{
    public function __construct(
        private readonly string $clientId,
        private readonly string $apiKey,
        private readonly string $checksumKey,
        private readonly HttpClient $http,
        private readonly string $baseUrl = 'https://api-merchant.payos.vn',
    ) {
    }

    public function name(): string
    {
        return 'payos';
    }

    public function createCheckout(string $gatewayOrderId, int $amountVnd, string $description, string $returnUrl, string $cancelUrl): array
    {
        $orderCode = (int) $gatewayOrderId;
        $description = mb_substr($description, 0, 25);
        $sig = hash_hmac('sha256', "amount=$amountVnd&cancelUrl=$cancelUrl&description=$description&orderCode=$orderCode&returnUrl=$returnUrl", $this->checksumKey);
        $res = $this->http->postJson($this->baseUrl . '/v2/payment-requests', [
            'orderCode' => $orderCode, 'amount' => $amountVnd, 'description' => $description,
            'returnUrl' => $returnUrl, 'cancelUrl' => $cancelUrl, 'signature' => $sig,
        ], ['x-client-id' => $this->clientId, 'x-api-key' => $this->apiKey]);
        if (($res['code'] ?? '') !== '00' || !isset($res['data']['checkoutUrl'])) {
            throw new \HolyMelody\ApiException(502, 'GATEWAY_ERROR', 'PayOS từ chối tạo thanh toán: ' . ($res['desc'] ?? 'không rõ'));
        }
        return ['checkout_url' => (string) $res['data']['checkoutUrl'], 'gateway_payload' => $res['data']];
    }

    /** Chữ ký webhook: HMAC-SHA256 của data sắp xếp theo khóa dạng k=v&… (null → chuỗi rỗng) */
    public static function signData(array $data, string $key): string
    {
        ksort($data);
        $parts = [];
        foreach ($data as $k => $v) {
            if (is_array($v)) {
                $v = json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            } elseif ($v === null || $v === 'null' || $v === 'undefined') {
                $v = '';
            } elseif (is_bool($v)) {
                $v = $v ? 'true' : 'false';
            }
            $parts[] = "$k=$v";
        }
        return hash_hmac('sha256', implode('&', $parts), $key);
    }

    public function parseNotification(array $input): Notification
    {
        $data = is_array($input['data'] ?? null) ? $input['data'] : [];
        $sig = (string) ($input['signature'] ?? '');
        $valid = $sig !== '' && $data && hash_equals(self::signData($data, $this->checksumKey), $sig);
        $success = ($input['code'] ?? '') === '00' && ($data['code'] ?? '') === '00';
        return new Notification(
            $valid, $success,
            (string) ($data['orderCode'] ?? ''),
            (int) ($data['amount'] ?? 0),
            (string) ($data['reference'] ?? ''),
            'payos:' . ($data['paymentLinkId'] ?? '') . ':' . ($data['reference'] ?? ''),
        );
    }
}

// ============================================================================ VNPay

final class VnpayGateway implements PaymentGateway
{
    public function __construct(
        private readonly string $tmnCode,
        private readonly string $hashSecret,
        private readonly string $payUrl = 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
        private readonly ?\Closure $clock = null,
    ) {
    }

    public function name(): string
    {
        return 'vnpay';
    }

    /** Chuỗi ký: các tham số vnp_* sắp xếp theo khóa, urlencode, nối bằng & ; HMAC-SHA512 */
    public static function sign(array $params, string $secret): string
    {
        unset($params['vnp_SecureHash'], $params['vnp_SecureHashType']);
        $params = array_filter($params, static fn ($v, $k) => str_starts_with((string) $k, 'vnp_') && $v !== '' && $v !== null, ARRAY_FILTER_USE_BOTH);
        ksort($params);
        $q = [];
        foreach ($params as $k => $v) {
            $q[] = urlencode((string) $k) . '=' . urlencode((string) $v);
        }
        return hash_hmac('sha512', implode('&', $q), $secret);
    }

    public function createCheckout(string $gatewayOrderId, int $amountVnd, string $description, string $returnUrl, string $cancelUrl): array
    {
        $now = $this->clock ? ($this->clock)() : new \DateTimeImmutable('now', new \DateTimeZone('Asia/Ho_Chi_Minh'));
        $p = [
            'vnp_Version' => '2.1.0', 'vnp_Command' => 'pay', 'vnp_TmnCode' => $this->tmnCode,
            'vnp_Amount' => (string) ($amountVnd * 100), 'vnp_CurrCode' => 'VND', 'vnp_TxnRef' => $gatewayOrderId,
            'vnp_OrderInfo' => $description, 'vnp_OrderType' => 'other', 'vnp_Locale' => 'vn',
            'vnp_ReturnUrl' => $returnUrl, 'vnp_IpAddr' => '127.0.0.1',
            'vnp_CreateDate' => $now->format('YmdHis'), 'vnp_ExpireDate' => $now->modify('+15 minutes')->format('YmdHis'),
        ];
        ksort($p);
        $url = $this->payUrl . '?' . http_build_query($p, '', '&', PHP_QUERY_RFC1738) . '&vnp_SecureHash=' . self::sign($p, $this->hashSecret);
        return ['checkout_url' => $url, 'gateway_payload' => $p];
    }

    public function parseNotification(array $input): Notification
    {
        $sig = (string) ($input['vnp_SecureHash'] ?? '');
        $valid = $sig !== '' && hash_equals(self::sign($input, $this->hashSecret), strtolower($sig));
        $success = ($input['vnp_ResponseCode'] ?? '') === '00' && ($input['vnp_TransactionStatus'] ?? '') === '00';
        return new Notification(
            $valid && ($input['vnp_TmnCode'] ?? '') === $this->tmnCode, $success,
            (string) ($input['vnp_TxnRef'] ?? ''),
            intdiv((int) ($input['vnp_Amount'] ?? 0), 100),
            (string) ($input['vnp_TransactionNo'] ?? ''),
            'vnpay:' . ($input['vnp_TxnRef'] ?? '') . ':' . ($input['vnp_TransactionNo'] ?? ''),
        );
    }
}

// ============================================================================ MoMo

final class MomoGateway implements PaymentGateway
{
    public function __construct(
        private readonly string $partnerCode,
        private readonly string $accessKey,
        private readonly string $secretKey,
        private readonly HttpClient $http,
        private readonly string $endpoint = 'https://test-payment.momo.vn/v2/gateway/api/create',
        private readonly string $ipnUrl = '',
    ) {
    }

    public function name(): string
    {
        return 'momo';
    }

    public static function ipnSignature(array $d, string $accessKey, string $secret): string
    {
        $raw = "accessKey=$accessKey&amount={$d['amount']}&extraData={$d['extraData']}&message={$d['message']}&orderId={$d['orderId']}"
            . "&orderInfo={$d['orderInfo']}&orderType={$d['orderType']}&partnerCode={$d['partnerCode']}&payType={$d['payType']}"
            . "&requestId={$d['requestId']}&responseTime={$d['responseTime']}&resultCode={$d['resultCode']}&transId={$d['transId']}";
        return hash_hmac('sha256', $raw, $secret);
    }

    public function createCheckout(string $gatewayOrderId, int $amountVnd, string $description, string $returnUrl, string $cancelUrl): array
    {
        $requestId = $gatewayOrderId . '-' . bin2hex(random_bytes(4));
        $type = 'captureWallet';
        $raw = "accessKey={$this->accessKey}&amount=$amountVnd&extraData=&ipnUrl={$this->ipnUrl}&orderId=$gatewayOrderId&orderInfo=$description"
            . "&partnerCode={$this->partnerCode}&redirectUrl=$returnUrl&requestId=$requestId&requestType=$type";
        $res = $this->http->postJson($this->endpoint, [
            'partnerCode' => $this->partnerCode, 'requestId' => $requestId, 'amount' => $amountVnd, 'orderId' => $gatewayOrderId,
            'orderInfo' => $description, 'redirectUrl' => $returnUrl, 'ipnUrl' => $this->ipnUrl, 'requestType' => $type,
            'extraData' => '', 'lang' => 'vi', 'signature' => hash_hmac('sha256', $raw, $this->secretKey),
        ]);
        if (($res['resultCode'] ?? -1) !== 0 || !isset($res['payUrl'])) {
            throw new \HolyMelody\ApiException(502, 'GATEWAY_ERROR', 'MoMo từ chối tạo thanh toán: ' . ($res['message'] ?? 'không rõ'));
        }
        return ['checkout_url' => (string) $res['payUrl'], 'gateway_payload' => $res];
    }

    public function parseNotification(array $input): Notification
    {
        $need = ['amount', 'extraData', 'message', 'orderId', 'orderInfo', 'orderType', 'partnerCode', 'payType', 'requestId', 'responseTime', 'resultCode', 'transId'];
        $complete = count(array_intersect_key(array_flip($need), $input)) === count($need);
        $valid = $complete && isset($input['signature'])
            && hash_equals(self::ipnSignature($input, $this->accessKey, $this->secretKey), (string) $input['signature'])
            && $input['partnerCode'] === $this->partnerCode;
        return new Notification(
            $valid, (int) ($input['resultCode'] ?? -1) === 0,
            (string) ($input['orderId'] ?? ''), (int) ($input['amount'] ?? 0), (string) ($input['transId'] ?? ''),
            'momo:' . ($input['orderId'] ?? '') . ':' . ($input['transId'] ?? ''),
        );
    }
}
