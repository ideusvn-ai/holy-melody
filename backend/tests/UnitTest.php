<?php
declare(strict_types=1);

require_once __DIR__ . '/helpers.php';

use HolyMelody\ApiException;
use HolyMelody\Auth\GoogleIdTokenVerifier;
use HolyMelody\Http\Request;
use HolyMelody\Http\Router;
use HolyMelody\Payments\HttpClient;
use HolyMelody\Payments\MomoGateway;
use HolyMelody\Payments\PaymentService;
use HolyMelody\Payments\PayOsGateway;
use HolyMelody\Payments\VnpayGateway;

// ------------------------------------------------------------------ Google ID token

T::test('JWK → PEM khớp khóa công khai gốc', function () {
    $k = TestKeys::get();
    $pem = GoogleIdTokenVerifier::jwkToPem($k['jwks']['keys'][0]);
    $orig = openssl_pkey_get_details($k['priv'])['key'];
    eq(trim($pem), trim($orig));
});

T::test('ID token hợp lệ được chấp nhận (web và desktop client)', function () {
    $c = TestKeys::verifier()->verify(TestKeys::token(TestKeys::claims()));
    eq($c['sub'], '1234567890');
    $c2 = TestKeys::verifier()->verify(TestKeys::token(TestKeys::claims(['aud' => 'desktop-client.apps.googleusercontent.com', 'iss' => 'accounts.google.com'])));
    eq($c2['aud'], 'desktop-client.apps.googleusercontent.com');
});

T::test('từ chối: sai chữ ký, sai aud, sai iss, hết hạn, alg none, kid lạ, payload bị sửa', function () {
    $v = TestKeys::verifier();
    $good = TestKeys::token(TestKeys::claims());
    [$h, $p, $s] = explode('.', $good);
    $tampered = $h . '.' . rtrim(strtr(base64_encode(json_encode(TestKeys::claims(['sub' => 'attacker']))), '+/', '-_'), '=') . '.' . $s;
    throwsCode(fn () => $v->verify($tampered), 'INVALID_ID_TOKEN');
    throwsCode(fn () => $v->verify(TestKeys::token(TestKeys::claims(['aud' => 'evil.apps.googleusercontent.com']))), 'INVALID_ID_TOKEN');
    throwsCode(fn () => $v->verify(TestKeys::token(TestKeys::claims(['iss' => 'https://evil.example']))), 'INVALID_ID_TOKEN');
    throwsCode(fn () => TestKeys::verifier(1_700_010_000)->verify($good), 'INVALID_ID_TOKEN');
    throwsCode(fn () => $v->verify(TestKeys::token(TestKeys::claims(), ['alg' => 'none'])), 'INVALID_ID_TOKEN');
    throwsCode(fn () => $v->verify(TestKeys::token(TestKeys::claims(), ['kid' => 'other'])), 'INVALID_ID_TOKEN');
    throwsCode(fn () => $v->verify('abc.def'), 'INVALID_ID_TOKEN');
});

T::test('verifier từ chối khởi tạo khi chưa cấu hình client ID', function () {
    throwsCode(fn () => new GoogleIdTokenVerifier([], fn () => ['keys' => []]), 'NOT_CONFIGURED');
});

// ------------------------------------------------------------------ cổng thanh toán

final class FakeHttp implements HttpClient
{
    public array $last = [];
    public function __construct(private array $response)
    {
    }
    public function postJson(string $url, array $body, array $headers = []): array
    {
        $this->last = ['url' => $url, 'body' => $body, 'headers' => $headers];
        return $this->response;
    }
}

T::test('PayOS: chữ ký webhook hợp lệ / bị sửa số tiền', function () {
    $gw = new PayOsGateway('cid', 'key', 'checksum-secret', new FakeHttp([]));
    $data = ['orderCode' => 123456, 'amount' => 100000, 'description' => 'HM1', 'accountNumber' => '12345678', 'reference' => 'FT123',
        'transactionDateTime' => '2026-11-17 10:00:00', 'currency' => 'VND', 'paymentLinkId' => 'pl_1', 'code' => '00', 'desc' => 'success',
        'counterAccountBankId' => null, 'counterAccountName' => null, 'virtualAccountName' => null];
    $body = ['code' => '00', 'desc' => 'success', 'success' => true, 'data' => $data, 'signature' => PayOsGateway::signData($data, 'checksum-secret')];
    $n = $gw->parseNotification($body);
    ok($n->signatureValid && $n->success);
    eq($n->gatewayOrderId, '123456');
    eq($n->amountVnd, 100000);
    $body['data']['amount'] = 1000000;
    ok(!$gw->parseNotification($body)->signatureValid, 'sửa số tiền phải làm chữ ký sai');
    ok(!$gw->parseNotification(['data' => $data])->signatureValid, 'thiếu chữ ký');
});

T::test('PayOS: tạo thanh toán gửi chữ ký đúng thứ tự trường', function () {
    $http = new FakeHttp(['code' => '00', 'data' => ['checkoutUrl' => 'https://pay.payos.vn/web/abc']]);
    $gw = new PayOsGateway('cid', 'key', 'secret', $http);
    $r = $gw->createCheckout('42', 300000, 'HM42', 'https://x/return', 'https://x/cancel');
    eq($r['checkout_url'], 'https://pay.payos.vn/web/abc');
    eq($http->last['body']['signature'], hash_hmac('sha256', 'amount=300000&cancelUrl=https://x/cancel&description=HM42&orderCode=42&returnUrl=https://x/return', 'secret'));
    eq($http->last['headers']['x-client-id'], 'cid');
});

T::test('VNPay: URL thanh toán và IPN dùng cùng thuật toán ký; phát hiện giả mạo', function () {
    $clock = fn () => new \DateTimeImmutable('2026-11-17 10:00:00', new \DateTimeZone('Asia/Ho_Chi_Minh'));
    $gw = new VnpayGateway('TMN01', 'vnp-secret', 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html', \Closure::fromCallable($clock));
    $url = $gw->createCheckout('99', 500000, 'Nap credit', 'https://x/return', 'https://x/cancel')['checkout_url'];
    parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
    eq($q['vnp_Amount'], '50000000');
    eq($q['vnp_SecureHash'], VnpayGateway::sign($q, 'vnp-secret'));
    $ipn = ['vnp_TmnCode' => 'TMN01', 'vnp_Amount' => '50000000', 'vnp_TxnRef' => '99', 'vnp_ResponseCode' => '00', 'vnp_TransactionStatus' => '00',
        'vnp_TransactionNo' => '14000001', 'vnp_BankCode' => 'NCB', 'vnp_OrderInfo' => 'Nap credit', 'vnp_PayDate' => '20261117101500'];
    $ipn['vnp_SecureHash'] = VnpayGateway::sign($ipn, 'vnp-secret');
    $n = $gw->parseNotification($ipn);
    ok($n->signatureValid && $n->success);
    eq($n->amountVnd, 500000);
    $ipn['vnp_Amount'] = '100';
    ok(!$gw->parseNotification($ipn)->signatureValid);
    $ipn2 = $ipn;
    $ipn2['vnp_TmnCode'] = 'OTHER';
    $ipn2['vnp_Amount'] = '50000000';
    $ipn2['vnp_SecureHash'] = VnpayGateway::sign($ipn2, 'vnp-secret');
    ok(!$gw->parseNotification($ipn2)->signatureValid, 'sai merchant');
});

T::test('MoMo: IPN hợp lệ / thiếu trường / sai partner', function () {
    $gw = new MomoGateway('MOMO01', 'acc', 'momo-secret', new FakeHttp([]));
    $ipn = ['partnerCode' => 'MOMO01', 'orderId' => '77', 'requestId' => '77-ab', 'amount' => 300000, 'orderInfo' => 'HM77', 'orderType' => 'momo_wallet',
        'transId' => 4088878653, 'resultCode' => 0, 'message' => 'Thành công.', 'payType' => 'qr', 'responseTime' => 1721720663942, 'extraData' => ''];
    $ipn['signature'] = MomoGateway::ipnSignature($ipn, 'acc', 'momo-secret');
    $n = $gw->parseNotification($ipn);
    ok($n->signatureValid && $n->success);
    eq($n->amountVnd, 300000);
    $bad = $ipn;
    unset($bad['payType']);
    ok(!$gw->parseNotification($bad)->signatureValid);
    $bad = $ipn;
    $bad['resultCode'] = 1006;
    ok(!$gw->parseNotification($bad)->signatureValid, 'đổi resultCode làm chữ ký sai');
});

T::test('mã đơn gửi cổng là số nguyên dương an toàn (≤ 2^53)', function () {
    $id = PaymentService::gatewayOrderId(987654321);
    ok(ctype_digit($id) && (int) $id > 0 && (int) $id < 2 ** 53);
});

// ------------------------------------------------------------------ HTTP

T::test('router: tham số đường dẫn, 404, 405, lỗi API → JSON', function () {
    $r = new Router();
    $r->add('GET', '/api/v1/jobs/{id}', fn (Request $q) => ['id' => $q->params['id']]);
    $r->add('POST', '/api/v1/fail', fn () => throw new ApiException(402, 'INSUFFICIENT_CREDITS', 'Không đủ credit', ['balance' => 5]));
    $req = fn (string $m, string $p) => new Request($m, $p, [], [], '');
    eq(json_decode($r->dispatch($req('GET', '/api/v1/jobs/42'))->body, true), ['id' => '42']);
    eq($r->dispatch($req('GET', '/api/v1/nope'))->status, 404);
    eq($r->dispatch($req('DELETE', '/api/v1/jobs/42'))->status, 405);
    $res = $r->dispatch($req('POST', '/api/v1/fail'));
    eq($res->status, 402);
    eq(json_decode($res->body, true)['error']['details']['balance'], 5);
    eq($r->dispatch($req('GET', '/api/v1/jobs/1;DROP'))->status, 404, 'tham số chỉ nhận ký tự an toàn');
});

T::test('request: bearer token, JSON lỗi', function () {
    $r = new Request('POST', '/', ['authorization' => 'Bearer abcdefghijklmnopqrstuvwxyz_-0123'], [], '{bad');
    eq($r->bearer(), 'abcdefghijklmnopqrstuvwxyz_-0123');
    ok((new Request('GET', '/', ['authorization' => 'Basic abc'], [], ''))->bearer() === null);
    throwsCode(fn () => $r->json(), 'INVALID_JSON');
});

T::test('AI: loại tác vụ chưa bật bị từ chối trước khi chạm CSDL', function () {
    $ref = new \ReflectionClass(\HolyMelody\Ai\AiJobService::class);
    $svc = $ref->newInstanceWithoutConstructor();
    $p = $ref->getProperty('enabledTypes');
    $p->setValue($svc, ['harmony']);
    ok($svc->isEnabled('harmony'));
    ok(!$svc->isEnabled('singer'));
    throwsCode(fn () => $svc->create(1, 'singer', 'x', [], 'idem-12345678'), 'AI_UNAVAILABLE');
});
