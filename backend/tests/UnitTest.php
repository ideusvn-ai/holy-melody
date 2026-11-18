<?php
declare(strict_types=1);

require_once __DIR__ . '/helpers.php';

use HolyMelody\ApiException;
use HolyMelody\Auth\GoogleIdTokenVerifier;
use HolyMelody\Http\Request;
use HolyMelody\Http\Router;
use HolyMelody\Payments\HttpClient;
use HolyMelody\Payments\PaymentService;
use HolyMelody\Payments\SePayGateway;

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

function sepayGw(string $secret = 'whsec', string $key = '', ?int $now = null): SePayGateway
{
    return new SePayGateway('MBBank', '0123456789', 'NGUYEN VAN A', 'https://hm.example', $secret, $key, 'HM', $now === null ? null : fn () => $now);
}

function sepayBody(string $code = 'HM0000421234', int $amount = 99000, string $type = 'in', string $acc = '0123456789'): string
{
    return json_encode(['id' => 92704, 'gateway' => 'MBBank', 'transactionDate' => '2026-11-18 10:30:00', 'accountNumber' => $acc, 'subAccount' => null,
        'code' => $code, 'content' => "$code thanh toan", 'transferType' => $type, 'transferAmount' => $amount, 'accumulated' => 1500000,
        'referenceCode' => 'FT26322XXXX', 'description' => "BankAPINotify $code"], JSON_UNESCAPED_UNICODE);
}

T::test('SePay: HMAC-SHA256 đúng định dạng sha256=hex(timestamp.body); chống phát lại 5 phút; sửa thân bị phát hiện', function () {
    $now = 1_800_000_000;
    $gw = sepayGw('whsec', '', $now);
    $body = sepayBody();
    $sig = 'sha256=' . hash_hmac('sha256', $now . '.' . $body, 'whsec');
    $n = $gw->parseNotification(json_decode($body, true), $body, ['x-sepay-signature' => $sig, 'x-sepay-timestamp' => (string) $now]);
    ok($n->signatureValid && $n->success);
    eq($n->gatewayOrderId, 'HM0000421234');
    eq($n->amountVnd, 99000);
    eq($n->eventId, 'sepay:92704');
    $tampered = str_replace('99000', '990000', $body);
    ok(!$gw->parseNotification(json_decode($tampered, true), $tampered, ['x-sepay-signature' => $sig, 'x-sepay-timestamp' => (string) $now])->signatureValid, 'sửa số tiền');
    $old = $now - 301;
    $sigOld = 'sha256=' . hash_hmac('sha256', $old . '.' . $body, 'whsec');
    ok(!$gw->parseNotification(json_decode($body, true), $body, ['x-sepay-signature' => $sigOld, 'x-sepay-timestamp' => (string) $old])->signatureValid, 'quá 5 phút');
    ok(!$gw->parseNotification(json_decode($body, true), $body, [])->signatureValid, 'thiếu chữ ký');
});

T::test('SePay: API key; chưa cấu hình xác thực thì không bao giờ hợp lệ', function () {
    $gw = sepayGw('', 'my-key');
    $body = sepayBody();
    ok($gw->parseNotification(json_decode($body, true), $body, ['authorization' => 'Apikey my-key'])->signatureValid);
    ok(!$gw->parseNotification(json_decode($body, true), $body, ['authorization' => 'Apikey other'])->signatureValid);
    ok(!sepayGw('', '')->parseNotification(json_decode($body, true), $body, ['authorization' => 'Apikey my-key'])->signatureValid);
});

T::test('SePay: chỉ nhận tiền VÀO đúng tài khoản; lấy mã từ nội dung khi trường code trống', function () {
    $gw = sepayGw('', 'k');
    $h = ['authorization' => 'Apikey k'];
    ok(!$gw->parseNotification(json_decode(sepayBody(type: 'out'), true), '', $h)->success, 'tiền ra');
    ok(!$gw->parseNotification(json_decode(sepayBody(acc: '999'), true), '', $h)->success, 'tài khoản khác');
    $d = json_decode(sepayBody(), true);
    $d['code'] = null;
    $d['content'] = 'MBVCB.123.hm 000042 1234.CT tu NGUYEN';
    eq($gw->parseNotification($d, '', $h)->gatewayOrderId, 'HM0000421234');
    $d['content'] = 'chuyen tien an trua';
    $d['description'] = 'BankAPINotify chuyen tien';
    eq($gw->parseNotification($d, '', $h)->gatewayOrderId, '');
});

T::test('SePay: mã thanh toán khó đoán, trang QR đúng tham số', function () {
    $gw = sepayGw();
    $c = $gw->orderCode(42);
    ok((bool) preg_match('/^HM000042\d{4}$/', $c), $c);
    $q = [];
    parse_str((string) parse_url($gw->qrUrl(99000, $c), PHP_URL_QUERY), $q);
    eq($q['acc'], '0123456789');
    eq($q['bank'], 'MBBank');
    eq($q['amount'], '99000');
    eq($q['des'], $c);
    eq($gw->createCheckout($c, 99000, $c, '', '')['checkout_url'], "https://hm.example/pay/$c");
});

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

T::test('AI OMR: lấy khối MusicXML hợp lệ từ câu trả lời của mô hình', function () {
    $ok = "Đây là kết quả:\n```xml\n<score-partwise version=\"4.0\"><part-list/></score-partwise>\n```";
    $x = \HolyMelody\Omr\OmrAiService::extractScore($ok);
    if ($x === null || !str_contains($x, '<score-partwise')) throw new RuntimeException('không lấy được MusicXML');
    if (\HolyMelody\Omr\OmrAiService::extractScore('xin lỗi, tôi không đọc được') !== null) throw new RuntimeException('phải trả null');
    if (\HolyMelody\Omr\OmrAiService::extractScore('<score-partwise><part></score-partwise>') !== null) throw new RuntimeException('XML hỏng phải trả null');
});
