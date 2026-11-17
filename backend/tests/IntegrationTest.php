<?php
declare(strict_types=1);

require_once __DIR__ . '/helpers.php';

use HolyMelody\Ai\AiJobService;
use HolyMelody\Auth\AuthService;
use HolyMelody\Db;
use HolyMelody\Payments\HttpClient;
use HolyMelody\Payments\PaymentService;
use HolyMelody\Payments\PayOsGateway;
use HolyMelody\Wallet\WalletService;

/**
 * Test tích hợp với MySQL thật. Bỏ qua nếu thiếu HM_TEST_DB_*.
 * CẢNH BÁO: xóa toàn bộ bảng trong CSDL test.
 */
function testDb(): Db
{
    static $db = null;
    if ($db) {
        return $db;
    }
    $host = getenv('HM_TEST_DB_HOST');
    $name = getenv('HM_TEST_DB_NAME');
    if (!$host || !$name || !getenv('HM_TEST_DB_USER')) {
        throw new SkipTest('chưa cấu hình HM_TEST_DB_HOST/NAME/USER');
    }
    $m = new mysqli($host, (string) getenv('HM_TEST_DB_USER'), (string) getenv('HM_TEST_DB_PASS'), $name, (int) (getenv('HM_TEST_DB_PORT') ?: 3306));
    $m->query('SET FOREIGN_KEY_CHECKS=0');
    $res = $m->query('SHOW TABLES');
    while ($row = $res->fetch_row()) {
        $m->query("DROP TABLE `{$row[0]}`");
    }
    $m->query('SET FOREIGN_KEY_CHECKS=1');
    foreach (glob(dirname(__DIR__) . '/migrations/*.sql') as $sql) {
        $m->multi_query((string) file_get_contents($sql));
        while ($m->more_results() && $m->next_result()) {
        }
    }
    return $db = new Db($m);
}

function newUser(Db $db, string $sub): int
{
    $auth = new AuthService($db, TestKeys::verifier(), new WalletService($db));
    return (int) $auth->loginWithGoogle(TestKeys::token(TestKeys::claims(['sub' => $sub])), 'desktop')['user']['id'];
}

T::test('[DB] tài khoản mới nhận 100 credit đúng một lần, khóa theo sub', function () {
    $db = testDb();
    $auth = new AuthService($db, TestKeys::verifier(), new WalletService($db));
    $a = $auth->loginWithGoogle(TestKeys::token(TestKeys::claims(['sub' => 'sub-A'])), 'desktop');
    $b = $auth->loginWithGoogle(TestKeys::token(TestKeys::claims(['sub' => 'sub-A', 'email' => 'doi-email@example.com'])), 'desktop');
    eq($a['balance'], 100);
    eq($b['balance'], 100, 'đăng nhập lại không cấp thêm');
    eq($a['user']['id'], $b['user']['id']);
    eq((int) $db->one('SELECT COUNT(*) c FROM credit_transactions WHERE type = \'signup_bonus\'')['c'], 1);
    $s = $auth->authenticate($a['token']);
    eq($s['user_id'], (int) $a['user']['id']);
    $auth->logout($s['session_id']);
    throwsCode(fn () => $auth->authenticate($a['token']), 'UNAUTHENTICATED');
});

T::test('[DB] chuyển sang Edit trừ 10 credit đúng một lần cho mỗi file gốc', function () {
    $db = testDb();
    $w = new WalletService($db);
    $svc = new \HolyMelody\Omr\OmrConversionService($db, $w);
    $uid = newUser($db, 'sub-OMR');
    $h = str_repeat('ab', 32);
    $a = $svc->convert($uid, $h, 'Bài A', 2, 32);
    $b = $svc->convert($uid, strtoupper($h), 'Bài A', 2, 32);
    ok(!$a['replayed'] && $b['replayed']);
    eq($a['conversion_id'], $b['conversion_id']);
    eq($w->balance($uid), 90);
    $svc->convert($uid, str_repeat('cd', 32), 'Bài B', 1, 8);
    eq($w->balance($uid), 80, 'file khác bị trừ riêng');
    throwsCode(fn () => $svc->convert($uid, 'xyz', 'x', 1, 1), 'INVALID_SOURCE_HASH');
    $w->apply($uid, -80, 'ai_charge', 'ai_job', 777, 'drain');
    throwsCode(fn () => $svc->convert($uid, str_repeat('ef', 32), 'Bài C', 1, 1), 'INSUFFICIENT_CREDITS');
    eq((int) $db->one('SELECT COUNT(*) c FROM omr_conversions WHERE user_id = ?', [$uid])['c'], 2, 'không còn bản ghi khi thiếu credit');
});

T::test('[DB] không thể âm credit; idempotency key không trừ hai lần', function () {
    $db = testDb();
    $w = new WalletService($db);
    $uid = newUser($db, 'sub-B');
    $r1 = $w->apply($uid, -30, 'ai_charge', 'ai_job', 9001, 'k-1');
    $r2 = $w->apply($uid, -30, 'ai_charge', 'ai_job', 9001, 'k-1');
    ok($r1['applied'] && !$r2['applied']);
    eq($w->balance($uid), 70);
    throwsCode(fn () => $w->apply($uid, -71, 'ai_charge', 'ai_job', 9002, 'k-2'), 'INSUFFICIENT_CREDITS');
    eq($w->balance($uid), 70);
    throwsCode(fn () => $w->apply($uid, -5, 'ai_charge', 'ai_job', 9003, 'k-1'), 'IDEMPOTENCY_CONFLICT');
});

T::test('[DB] AI job: retry cùng Idempotency-Key không trừ lại; lỗi hệ thống hoàn đúng một lần; hủy hoàn credit', function () {
    $db = testDb();
    $w = new WalletService($db);
    $ai = new AiJobService($db, $w);
    $uid = newUser($db, 'sub-C');
    $j1 = $ai->create($uid, 'singer', 's3://in/1.musicxml', [], 'idem-aaaaaaaa');
    $j1b = $ai->create($uid, 'singer', 's3://in/1.musicxml', [], 'idem-aaaaaaaa');
    eq($j1['id'], $j1b['id']);
    ok($j1b['replayed']);
    eq($w->balance($uid), 90);
    $claimed = $ai->claim('w1');
    eq((int) $claimed['id'], $j1['id']);
    eq($ai->fail($j1['id'], 'w1', 'PROVIDER_TIMEOUT', 't/o', true, true), 'requeued');
    eq($w->balance($uid), 90, 'worker retry không tốn thêm credit');
    $ai->claim('w1');
    eq($ai->fail($j1['id'], 'w1', 'PROVIDER_DOWN', 'down', false, true), 'failed');
    eq($w->balance($uid), 100, 'hoàn credit');
    eq((int) $db->one('SELECT COUNT(*) c FROM credit_transactions WHERE reference_id = ? AND type = \'ai_refund\'', [$j1['id']])['c'], 1);
    $j2 = $ai->create($uid, 'harmony', 's3://in/2', [], 'idem-bbbbbbbb');
    $ai->cancel($uid, $j2['id']);
    eq($w->balance($uid), 100);
    throwsCode(fn () => $ai->cancel($uid, $j2['id']), 'JOB_NOT_CANCELLABLE');
});

T::test('[DB] thiếu credit thì không tạo job', function () {
    $db = testDb();
    $w = new WalletService($db);
    $ai = new AiJobService($db, $w);
    $uid = newUser($db, 'sub-D');
    $db->exec('UPDATE ai_pricing SET credit_cost = 150 WHERE job_type = \'lyrics\'');
    throwsCode(fn () => $ai->create($uid, 'lyrics', 'x', [], 'idem-cccccccc'), 'INSUFFICIENT_CREDITS');
    eq((int) $db->one('SELECT COUNT(*) c FROM ai_jobs WHERE user_id = ?', [$uid])['c'], 0);
    $db->exec('UPDATE ai_pricing SET credit_cost = 10 WHERE job_type = \'lyrics\'');
});

T::test('[DB] webhook thanh toán lặp lại chỉ cộng credit một lần; sai số tiền/chữ ký không cộng', function () {
    $db = testDb();
    $w = new WalletService($db);
    $http = new class implements HttpClient {
        public function postJson(string $url, array $body, array $headers = []): array
        {
            return ['code' => '00', 'data' => ['checkoutUrl' => 'https://pay.example/' . $body['orderCode']]];
        }
    };
    $pay = new PaymentService($db, $w, ['payos' => new PayOsGateway('c', 'k', 'sum', $http)], 'https://x/r', 'https://x/c');
    $uid = newUser($db, 'sub-E');
    $order = $pay->createOrder($uid, 2, 'payos', 'order-key-1');
    eq($pay->createOrder($uid, 2, 'payos', 'order-key-1')['id'], $order['id'], 'tạo đơn idempotent');
    $code = $db->one('SELECT gateway_order_id FROM payment_orders WHERE id = ?', [$order['id']])['gateway_order_id'];
    $data = ['orderCode' => (int) $code, 'amount' => 300000, 'description' => 'HM', 'reference' => 'FT1', 'paymentLinkId' => 'pl', 'code' => '00', 'desc' => 'ok'];
    $body = ['code' => '00', 'desc' => 'ok', 'data' => $data, 'signature' => PayOsGateway::signData($data, 'sum')];

    $bad = $body;
    $bad['data']['amount'] = 3000;
    $bad['signature'] = PayOsGateway::signData($bad['data'], 'sum');
    eq($pay->handleNotification('payos', $bad)['status'], 'amount_mismatch');
    $forged = $body;
    $forged['signature'] = str_repeat('0', 64);
    eq($pay->handleNotification('payos', $forged)['status'], 'invalid_signature');
    eq($w->balance($uid), 100);

    eq($pay->handleNotification('payos', $body)['status'], 'valid');
    eq($pay->handleNotification('payos', $body)['status'], 'duplicate');
    eq($pay->handleNotification('payos', $body)['status'], 'duplicate');
    eq($w->balance($uid), 400);
    eq($pay->orderStatus($uid, $order['id'])['status'], 'paid');
});

T::test('[DB] trừ credit song song (5 tiến trình) không làm số dư âm', function () {
    // 5 tiến trình PHP ĐỘC LẬP (không fork: tiến trình con thoát sẽ đóng kết nối MySQL dùng chung của cha)
    $db = testDb();
    $uid = newUser($db, 'sub-F'); // 100 credit
    $script = tempnam(sys_get_temp_dir(), 'hmrace') . '.php';
    file_put_contents($script, '<?php
require ' . var_export(dirname(__DIR__) . '/src/bootstrap.php', true) . ';
$m = new mysqli(getenv("HM_TEST_DB_HOST"), getenv("HM_TEST_DB_USER"), (string) getenv("HM_TEST_DB_PASS"), getenv("HM_TEST_DB_NAME"), (int) (getenv("HM_TEST_DB_PORT") ?: 3306));
$w = new HolyMelody\\Wallet\\WalletService(new HolyMelody\\Db($m));
try { $w->apply((int) $argv[1], -30, "ai_charge", "ai_job", 50000 + (int) $argv[2], "race-" . $argv[2]); exit(0); } catch (Throwable $e) { exit(1); }
');
    $procs = [];
    for ($i = 0; $i < 5; $i++) {
        $procs[] = proc_open([PHP_BINARY, $script, (string) $uid, (string) $i], [], $pipes);
    }
    $ok = 0;
    foreach ($procs as $p) {
        $ok += proc_close($p) === 0 ? 1 : 0;
    }
    @unlink($script);
    eq($ok, 3, 'chỉ 3 lần trừ 30 thành công từ 100');
    eq((new WalletService($db))->balance($uid), 10);
});

T::test('[DB] loại AI chưa bật trên máy chủ: từ chối và KHÔNG trừ credit', function () {
    $db = testDb();
    $w = new WalletService($db);
    $ai = new AiJobService($db, $w, ['harmony']);
    $uid = newUser($db, 'sub-G');
    throwsCode(fn () => $ai->create($uid, 'singer', 'x', [], 'idem-gggggggg'), 'AI_UNAVAILABLE');
    eq($w->balance($uid), 100);
});
