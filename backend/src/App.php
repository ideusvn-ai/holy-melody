<?php
declare(strict_types=1);

namespace HolyMelody;

use HolyMelody\Ai\AiJobService;
use HolyMelody\Auth\AuthService;
use HolyMelody\Auth\GoogleIdTokenVerifier;
use HolyMelody\Http\Request;
use HolyMelody\Http\Response;
use HolyMelody\Http\Router;
use HolyMelody\Payments\CurlHttpClient;
use HolyMelody\Payments\MomoGateway;
use HolyMelody\Payments\PaymentService;
use HolyMelody\Payments\PayOsGateway;
use HolyMelody\Payments\VnpayGateway;
use HolyMelody\Support\RateLimiter;
use HolyMelody\Wallet\WalletService;

/**
 * Định tuyến REST API v1. Mọi thao tác cộng/trừ credit chỉ xảy ra ở server.
 */
final class App
{
    private Router $router;
    private ?AuthService $auth = null;

    public function __construct(
        private readonly Config $config,
        private readonly Db $db,
    ) {
        $this->router = new Router();
        $this->routes();
    }

    public function handle(Request $req): Response
    {
        try {
            $res = $this->router->dispatch($req);
        } catch (\Throwable $e) {
            $this->logError($e, $req);
            $res = Response::error(new ApiException(500, 'INTERNAL', 'Lỗi hệ thống'));
        }
        $origin = $req->header('origin');
        if ($origin && in_array($origin, $this->config->list('HM_CORS_ORIGINS'), true)) {
            $res->headers['Access-Control-Allow-Origin'] = $origin;
            $res->headers['Vary'] = 'Origin';
            $res->headers['Access-Control-Allow-Credentials'] = 'true';
        }
        return $res;
    }

    // ------------------------------------------------------------------ services (khởi tạo lười)

    private function wallet(): WalletService
    {
        return new WalletService($this->db);
    }

    private function authService(): AuthService
    {
        return $this->auth ??= new AuthService(
            $this->db,
            new GoogleIdTokenVerifier(
                $this->config->list('HM_GOOGLE_CLIENT_IDS'),
                GoogleIdTokenVerifier::cachedJwks(sys_get_temp_dir() . '/hm-google-jwks.json'),
            ),
            $this->wallet(),
        );
    }

    private function payments(): PaymentService
    {
        $c = $this->config;
        $http = new CurlHttpClient();
        $gws = [];
        if ($c->get('HM_PAYOS_CLIENT_ID')) {
            $gws['payos'] = new PayOsGateway($c->require('HM_PAYOS_CLIENT_ID'), $c->require('HM_PAYOS_API_KEY'), $c->require('HM_PAYOS_CHECKSUM_KEY'), $http);
        }
        if ($c->get('HM_VNPAY_TMN_CODE')) {
            $gws['vnpay'] = new VnpayGateway($c->require('HM_VNPAY_TMN_CODE'), $c->require('HM_VNPAY_HASH_SECRET'), $c->get('HM_VNPAY_PAY_URL') ?? 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html');
        }
        if ($c->get('HM_MOMO_PARTNER_CODE')) {
            $gws['momo'] = new MomoGateway($c->require('HM_MOMO_PARTNER_CODE'), $c->require('HM_MOMO_ACCESS_KEY'), $c->require('HM_MOMO_SECRET_KEY'), $http,
                $c->get('HM_MOMO_ENDPOINT') ?? 'https://test-payment.momo.vn/v2/gateway/api/create', $c->require('HM_PUBLIC_URL') . '/api/v1/webhooks/momo');
        }
        $base = $c->get('HM_PUBLIC_URL') ?? '';
        return new PaymentService($this->db, $this->wallet(), $gws, "$base/account/payment-return", "$base/account/payment-cancel");
    }

    private function ai(): AiJobService
    {
        return new AiJobService($this->db, $this->wallet());
    }

    private function limiter(): RateLimiter
    {
        return new RateLimiter($this->db);
    }

    // ------------------------------------------------------------------ middleware

    private function requireUser(): callable
    {
        return function (Request $r): void {
            $token = $r->bearer() ?? ($r->cookies['hm_session'] ?? null);
            if (!$token) {
                throw new ApiException(401, 'UNAUTHENTICATED', 'Cần đăng nhập');
            }
            $session = $this->authService()->authenticate($token);
            // Phiên cookie (website) phải gửi CSRF token cho yêu cầu thay đổi dữ liệu
            if ($r->bearer() === null && !in_array($r->method, ['GET', 'HEAD', 'OPTIONS'], true)) {
                $csrf = $r->header('x-csrf-token') ?? '';
                if (!$session['csrf_hash'] || !hash_equals($session['csrf_hash'], hash('sha256', $csrf, true))) {
                    throw new ApiException(403, 'CSRF', 'CSRF token không hợp lệ');
                }
            }
            $r->auth = $session;
            $this->limiter()->hit('user:' . $session['user_id'], 120, 60);
        };
    }

    private function requireAdmin(string ...$roles): callable
    {
        $user = $this->requireUser();
        return function (Request $r) use ($user, $roles): void {
            $user($r);
            $row = $this->db->one('SELECT role FROM admin_users WHERE user_id = ?', [$r->auth['user_id']]);
            if (!$row || ($roles && !in_array($row['role'], [...$roles, 'owner'], true))) {
                throw new ApiException(403, 'FORBIDDEN', 'Không có quyền quản trị');
            }
            $r->auth['admin_role'] = $row['role'];
        };
    }

    private function requireWorker(): callable
    {
        return function (Request $r): void {
            $expected = $this->config->get('HM_WORKER_TOKEN');
            $got = $r->bearer() ?? '';
            if (!$expected || !hash_equals($expected, $got)) {
                throw new ApiException(401, 'UNAUTHENTICATED', 'Worker token không hợp lệ');
            }
        };
    }

    private function ipLimit(string $name, int $limit): callable
    {
        return fn (Request $r) => $this->limiter()->hit("$name:{$r->ip}", $limit, 60);
    }

    // ------------------------------------------------------------------ routes

    private function routes(): void
    {
        $r = $this->router;
        $user = $this->requireUser();

        $r->add('GET', '/api/v1/health', fn () => ['ok' => true, 'time' => gmdate('c')]);

        // ---- auth
        $r->add('POST', '/api/v1/auth/google', function (Request $req) {
            $b = $req->json();
            $res = $this->authService()->loginWithGoogle((string) ($b['id_token'] ?? ''), (string) ($b['client'] ?? 'desktop'), (string) $req->header('user-agent'), $req->ip);
            $isWeb = ($b['client'] ?? 'desktop') === 'web';
            $resp = Response::json([
                // desktop nhận token để lưu vào keychain; website dùng cookie HttpOnly, không lộ token cho JavaScript
                'token' => $isWeb ? null : $res['token'],
                'csrf_token' => $res['csrf'],
                'user' => ['id' => (int) $res['user']['id'], 'email' => $res['user']['email'], 'name' => $res['user']['name'], 'avatar_url' => $res['user']['avatar_url']],
                'balance' => $res['balance'],
                'is_new' => $res['isNew'],
            ]);
            if ($isWeb) {
                setcookie('hm_session', $res['token'], ['expires' => time() + 30 * 86400, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
            }
            return $resp;
        }, [$this->ipLimit('login', 20)]);
        $r->add('POST', '/api/v1/auth/logout', function (Request $req) {
            $this->authService()->logout($req->auth['session_id']);
            return ['ok' => true];
        }, [$user]);

        // ---- tài khoản & credit
        $r->add('GET', '/api/v1/me', function (Request $req) {
            $u = $this->db->one('SELECT id, email, name, avatar_url, created_at FROM users WHERE id = ?', [$req->auth['user_id']]);
            return ['user' => $u, 'balance' => $this->wallet()->balance($req->auth['user_id'])];
        }, [$user]);
        $r->add('GET', '/api/v1/me/transactions', fn (Request $req) => [
            'items' => $this->wallet()->history($req->auth['user_id'], (int) ($req->query['limit'] ?? 50), isset($req->query['before']) ? (int) $req->query['before'] : null),
        ], [$user]);
        $r->add('GET', '/api/v1/pricing', fn () => [
            'packages' => $this->payments()->packages(),
            'ai' => $this->db->all('SELECT job_type, credit_cost FROM ai_pricing WHERE active = 1'),
        ]);

        // ---- thanh toán
        $r->add('POST', '/api/v1/payments/orders', function (Request $req) {
            $b = $req->json();
            $key = (string) ($req->header('idempotency-key') ?? '');
            if (!preg_match('/^[A-Za-z0-9_\-]{8,100}$/', $key)) {
                throw new ApiException(400, 'INVALID_IDEMPOTENCY_KEY', 'Thiếu header Idempotency-Key');
            }
            return Response::json($this->payments()->createOrder($req->auth['user_id'], (int) ($b['package_id'] ?? 0), (string) ($b['gateway'] ?? 'payos'), $key), 201);
        }, [$user]);
        $r->add('GET', '/api/v1/payments/orders/{id}', function (Request $req) {
            return $this->payments()->orderStatus($req->auth['user_id'], (int) $req->params['id'])
                ?? throw new ApiException(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
        }, [$user]);

        // ---- webhook / IPN (không cần đăng nhập; xác thực bằng chữ ký)
        $r->add('POST', '/api/v1/webhooks/payos', function (Request $req) {
            $res = $this->payments()->handleNotification('payos', $req->json());
            return ['success' => in_array($res['status'], ['valid', 'duplicate', 'not_success'], true)];
        }, [$this->ipLimit('webhook', 300)]);
        $r->add('POST', '/api/v1/webhooks/momo', function (Request $req) {
            $this->payments()->handleNotification('momo', $req->json());
            return new Response(204, '');
        }, [$this->ipLimit('webhook', 300)]);
        $r->add('GET', '/api/v1/webhooks/vnpay', function (Request $req) {
            $res = $this->payments()->handleNotification('vnpay', $req->query);
            // Mã phản hồi IPN theo đặc tả VNPay
            $code = match ($res['status']) {
                'valid', 'not_success' => ['00', 'Confirm Success'],
                'duplicate' => ['02', 'Order already confirmed'],
                'unknown_order' => ['01', 'Order not found'],
                'amount_mismatch' => ['04', 'Invalid amount'],
                'invalid_signature' => ['97', 'Invalid signature'],
                default => ['99', 'Unknown error'],
            };
            return ['RspCode' => $code[0], 'Message' => $code[1]];
        }, [$this->ipLimit('webhook', 300)]);

        // ---- AI jobs
        $r->add('POST', '/api/v1/ai/jobs', function (Request $req) {
            $b = $req->json();
            $job = $this->ai()->create($req->auth['user_id'], (string) ($b['type'] ?? ''), (string) ($b['input_reference'] ?? ''),
                is_array($b['params'] ?? null) ? $b['params'] : [], (string) ($req->header('idempotency-key') ?? ''));
            return Response::json($job + ['balance' => $this->wallet()->balance($req->auth['user_id'])], $job['replayed'] ? 200 : 201);
        }, [$user]);
        $r->add('GET', '/api/v1/ai/jobs/{id}', fn (Request $req) => $this->ai()->get($req->auth['user_id'], (int) $req->params['id'])
            ?? throw new ApiException(404, 'NOT_FOUND', 'Không tìm thấy job'), [$user]);
        $r->add('POST', '/api/v1/ai/jobs/{id}/cancel', fn (Request $req) => $this->ai()->cancel($req->auth['user_id'], (int) $req->params['id']), [$user]);
        $r->add('GET', '/api/v1/ai/jobs', fn (Request $req) => ['items' => $this->db->all(
            'SELECT id, job_type, status, credit_cost, progress, created_at, completed_at FROM ai_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 100',
            [$req->auth['user_id']],
        )], [$user]);

        // ---- worker nội bộ
        $worker = $this->requireWorker();
        $r->add('POST', '/api/v1/worker/claim', fn (Request $req) => ['job' => $this->ai()->claim((string) ($req->json()['worker_id'] ?? 'worker'))], [$worker]);
        $r->add('POST', '/api/v1/worker/jobs/{id}/progress', function (Request $req) {
            $b = $req->json();
            $this->ai()->progress((int) $req->params['id'], (string) ($b['worker_id'] ?? ''), (int) ($b['progress'] ?? 0));
            return ['ok' => true];
        }, [$worker]);
        $r->add('POST', '/api/v1/worker/jobs/{id}/complete', function (Request $req) {
            $b = $req->json();
            $this->ai()->complete((int) $req->params['id'], (string) ($b['worker_id'] ?? ''), (string) ($b['provider'] ?? ''), $b['provider_job_id'] ?? null, $b['outputs'] ?? []);
            return ['ok' => true];
        }, [$worker]);
        $r->add('POST', '/api/v1/worker/jobs/{id}/fail', function (Request $req) {
            $b = $req->json();
            return ['result' => $this->ai()->fail((int) $req->params['id'], (string) ($b['worker_id'] ?? ''), (string) ($b['error_code'] ?? 'ERROR'),
                (string) ($b['message'] ?? ''), (bool) ($b['retryable'] ?? false), (bool) ($b['refundable'] ?? true))];
        }, [$worker]);

        // ---- phát hành
        $r->add('GET', '/api/v1/releases/latest', fn () => ['items' => $this->db->all(
            'SELECT r.version, r.platform, r.architecture, r.download_url, r.file_size, r.checksum, r.signed, r.release_notes, r.min_os_version, r.published_at
             FROM app_releases r JOIN (SELECT platform, architecture, MAX(published_at) p FROM app_releases WHERE published_at IS NOT NULL GROUP BY platform, architecture) l
               ON l.platform = r.platform AND l.architecture = r.architecture AND l.p = r.published_at',
        )]);

        // ---- quản trị
        $r->add('GET', '/api/v1/admin/stats', fn () => [
            'users' => (int) $this->db->one('SELECT COUNT(*) c FROM users')['c'],
            'new_users_7d' => (int) $this->db->one('SELECT COUNT(*) c FROM users WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)')['c'],
            'credits_granted' => (int) $this->db->one('SELECT COALESCE(SUM(amount),0) s FROM credit_transactions WHERE amount > 0')['s'],
            'credits_used' => (int) -$this->db->one("SELECT COALESCE(SUM(amount),0) s FROM credit_transactions WHERE type = 'ai_charge'")['s']
                - (int) $this->db->one("SELECT COALESCE(SUM(amount),0) s FROM credit_transactions WHERE type = 'ai_refund'")['s'],
            'revenue_vnd' => (int) $this->db->one("SELECT COALESCE(SUM(amount_vnd),0) s FROM payment_orders WHERE status = 'paid'")['s'],
            'orders_by_status' => $this->db->all('SELECT status, COUNT(*) n FROM payment_orders GROUP BY status'),
            'jobs_by_status' => $this->db->all('SELECT status, COUNT(*) n FROM ai_jobs GROUP BY status'),
            'revenue_daily' => $this->db->all("SELECT DATE(paid_at) d, SUM(amount_vnd) vnd FROM payment_orders WHERE status = 'paid' AND paid_at > DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY DATE(paid_at) ORDER BY d"),
        ], [$this->requireAdmin('viewer', 'support', 'finance')]);
        $r->add('POST', '/api/v1/admin/users/{id}/credits', function (Request $req) {
            $b = $req->json();
            $amount = (int) ($b['amount'] ?? 0);
            $reason = trim((string) ($b['reason'] ?? ''));
            if ($amount === 0 || mb_strlen($reason) < 5) {
                throw new ApiException(400, 'INVALID', 'Cần số credit khác 0 và lý do (≥ 5 ký tự)');
            }
            $target = (int) $req->params['id'];
            return $this->db->tx(function (Db $db) use ($req, $amount, $reason, $target) {
                $db->exec('INSERT INTO admin_credit_adjustments (user_id, admin_user_id, amount, reason) VALUES (?, ?, ?, ?)', [$target, $req->auth['user_id'], $amount, $reason]);
                $adjId = $db->lastId();
                $tx = $this->wallet()->apply($target, $amount, 'admin_adjustment', 'admin_adjustment', $adjId, "admin_adj:$adjId", $reason);
                $db->exec('INSERT INTO audit_logs (actor_user_id, actor_type, action, target_type, target_id, details, ip) VALUES (?, \'admin\', \'credits.adjust\', \'user\', ?, ?, ?)',
                    [$req->auth['user_id'], $target, json_encode(['amount' => $amount, 'reason' => $reason, 'adjustment_id' => $adjId], JSON_UNESCAPED_UNICODE), AuthService::packIp($req->ip)]);
                return ['adjustment_id' => $adjId, 'balance' => $tx['balance_after']];
            });
        }, [$this->requireAdmin('finance')]);
        $r->add('PUT', '/api/v1/admin/pricing/{type}', function (Request $req) {
            $cost = (int) ($req->json()['credit_cost'] ?? -1);
            if ($cost < 0 || $cost > 100000) {
                throw new ApiException(400, 'INVALID', 'Giá không hợp lệ');
            }
            $this->db->exec('UPDATE ai_pricing SET credit_cost = ?, updated_by = ? WHERE job_type = ?', [$cost, $req->auth['user_id'], $req->params['type']]);
            $this->db->exec('INSERT INTO audit_logs (actor_user_id, actor_type, action, target_type, details) VALUES (?, \'admin\', \'pricing.update\', \'ai_pricing\', ?)',
                [$req->auth['user_id'], json_encode(['type' => $req->params['type'], 'credit_cost' => $cost])]);
            return ['ok' => true];
        }, [$this->requireAdmin('finance')]);
    }

    private function logError(\Throwable $e, Request $req): void
    {
        error_log(sprintf('[holy-melody] %s: %s @ %s:%d', $e::class, $e->getMessage(), $e->getFile(), $e->getLine()));
        try {
            $this->db->exec('INSERT INTO error_logs (source, level, message, context) VALUES (\'api\', \'error\', ?, ?)',
                [mb_substr($e->getMessage(), 0, 2000), json_encode(['path' => $req->path, 'method' => $req->method, 'type' => $e::class])]);
        } catch (\Throwable) {
            // không để lỗi ghi log che lỗi gốc
        }
    }
}
