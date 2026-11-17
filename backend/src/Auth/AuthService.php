<?php
declare(strict_types=1);

namespace HolyMelody\Auth;

use HolyMelody\ApiException;
use HolyMelody\Db;
use HolyMelody\Wallet\WalletService;

/**
 * Đăng nhập bằng Google ID token → tạo/cập nhật user theo `sub`, cấp 100 credit đúng một lần,
 * phát session token ngẫu nhiên (chỉ lưu SHA-256).
 */
final class AuthService
{
    public const SIGNUP_BONUS = 100;
    private const SESSION_DAYS = 30;

    public function __construct(
        private readonly Db $db,
        private readonly GoogleIdTokenVerifier $verifier,
        private readonly WalletService $wallet,
    ) {
    }

    /** @return array{token:string, csrf:?string, user:array<string,mixed>, balance:int, isNew:bool} */
    public function loginWithGoogle(string $idToken, string $client, string $userAgent = '', string $ip = ''): array
    {
        if (!in_array($client, ['desktop', 'web'], true)) {
            throw new ApiException(400, 'INVALID_CLIENT', 'client phải là desktop hoặc web');
        }
        $claims = $this->verifier->verify($idToken);
        $sub = (string) $claims['sub'];
        $email = isset($claims['email']) ? (string) $claims['email'] : null;
        $verified = ($claims['email_verified'] ?? false) === true || ($claims['email_verified'] ?? '') === 'true';

        return $this->db->tx(function (Db $db) use ($sub, $email, $verified, $claims, $client, $userAgent, $ip) {
            // UNIQUE(google_sub) đảm bảo mỗi tài khoản Google chỉ có một user, kể cả khi đăng nhập song song
            $db->exec(
                'INSERT INTO users (google_sub, email, email_verified, name, avatar_url, last_login_at)
                 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
                 ON DUPLICATE KEY UPDATE email = VALUES(email), email_verified = VALUES(email_verified),
                   name = VALUES(name), avatar_url = VALUES(avatar_url), last_login_at = CURRENT_TIMESTAMP(3)',
                [$sub, $email, $verified ? 1 : 0, mb_substr((string) ($claims['name'] ?? ''), 0, 255) ?: null, $claims['picture'] ?? null],
            );
            $user = $db->one('SELECT id, google_sub, email, name, avatar_url, status, created_at FROM users WHERE google_sub = ? FOR UPDATE', [$sub]);
            if (!$user || $user['status'] !== 'active') {
                throw new ApiException(403, 'ACCOUNT_DISABLED', 'Tài khoản đã bị khóa');
            }
            $uid = (int) $user['id'];
            $isNew = $this->wallet->ensureWallet($uid);
            // Idempotent theo user: dù gọi bao nhiêu lần cũng chỉ cấp một lần
            $this->wallet->apply($uid, self::SIGNUP_BONUS, 'signup_bonus', 'user', $uid, "signup:$uid", 'Quà tặng tài khoản mới');

            $token = self::randomToken();
            $csrf = $client === 'web' ? self::randomToken() : null;
            $db->exec(
                'INSERT INTO user_sessions (user_id, token_hash, csrf_token_hash, client, user_agent, ip, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? DAY))',
                [$uid, hash('sha256', $token, true), $csrf ? hash('sha256', $csrf, true) : null, $client, mb_substr($userAgent, 0, 512), self::packIp($ip), self::SESSION_DAYS],
            );
            return ['token' => $token, 'csrf' => $csrf, 'user' => $user, 'balance' => $this->wallet->balance($uid), 'isNew' => $isNew];
        });
    }

    /** @return array{user_id:int, session_id:int, client:string, csrf_hash:?string} */
    public function authenticate(string $token): array
    {
        $row = $this->db->one(
            'SELECT s.id, s.user_id, s.client, s.csrf_token_hash FROM user_sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP(3) AND u.status = \'active\'',
            [hash('sha256', $token, true)],
        );
        if (!$row) {
            throw new ApiException(401, 'UNAUTHENTICATED', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
        }
        $this->db->exec('UPDATE user_sessions SET last_used_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND (last_used_at IS NULL OR last_used_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE))', [(int) $row['id']]);
        return ['user_id' => (int) $row['user_id'], 'session_id' => (int) $row['id'], 'client' => (string) $row['client'], 'csrf_hash' => $row['csrf_token_hash']];
    }

    public function logout(int $sessionId): void
    {
        $this->db->exec('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL', [$sessionId]);
    }

    public static function randomToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function packIp(string $ip): ?string
    {
        $p = @inet_pton($ip);
        return $p === false ? null : $p;
    }
}
