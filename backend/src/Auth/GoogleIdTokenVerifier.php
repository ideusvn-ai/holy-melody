<?php
declare(strict_types=1);

namespace HolyMelody\Auth;

use HolyMelody\ApiException;

/**
 * Xác minh Google ID token (JWT RS256) theo hướng dẫn của Google:
 *  - chữ ký hợp lệ với khóa công khai trong JWKS (theo `kid`)
 *  - iss ∈ {accounts.google.com, https://accounts.google.com}
 *  - aud ∈ danh sách client ID của Holy Melody (web + desktop)
 *  - exp còn hạn (cho phép lệch đồng hồ nhỏ), iat không ở tương lai
 * Không bao giờ tin email/sub gửi từ client mà không qua bước này.
 */
final class GoogleIdTokenVerifier
{
    public const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
    private const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

    /** @var callable():array{keys:list<array<string,string>>} */
    private $jwksProvider;

    /**
     * @param list<string> $allowedAudiences
     * @param callable():array{keys:list<array<string,string>>} $jwksProvider
     * @param callable():int|null $clock
     */
    public function __construct(
        private readonly array $allowedAudiences,
        callable $jwksProvider,
        private readonly int $leewaySeconds = 60,
        private $clock = null,
    ) {
        if (!$allowedAudiences) {
            throw new \HolyMelody\NotConfiguredException('Chưa cấu hình Google client ID (HM_GOOGLE_CLIENT_IDS)');
        }
        $this->jwksProvider = $jwksProvider;
    }

    /** @return array<string,mixed> claims đã xác minh */
    public function verify(string $jwt): array
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) {
            throw self::invalid('Định dạng token sai');
        }
        [$h64, $p64, $s64] = $parts;
        $header = self::jsonPart($h64);
        $claims = self::jsonPart($p64);
        if (($header['alg'] ?? '') !== 'RS256') {
            throw self::invalid('Thuật toán không được phép');
        }
        $kid = (string) ($header['kid'] ?? '');
        $jwk = null;
        foreach ((($this->jwksProvider)())['keys'] ?? [] as $k) {
            if (($k['kid'] ?? null) === $kid && ($k['kty'] ?? '') === 'RSA') {
                $jwk = $k;
                break;
            }
        }
        if (!$jwk) {
            throw self::invalid('Không tìm thấy khóa ký');
        }
        $sig = self::b64urlDecode($s64);
        $ok = openssl_verify("$h64.$p64", $sig, self::jwkToPem($jwk), OPENSSL_ALGO_SHA256);
        if ($ok !== 1) {
            throw self::invalid('Chữ ký không hợp lệ');
        }
        $now = $this->clock ? ($this->clock)() : time();
        if (!in_array($claims['iss'] ?? null, self::ISSUERS, true)) {
            throw self::invalid('Issuer không hợp lệ');
        }
        $aud = $claims['aud'] ?? null;
        $auds = is_array($aud) ? $aud : [$aud];
        if (!array_intersect($auds, $this->allowedAudiences)) {
            throw self::invalid('Audience không hợp lệ');
        }
        if (!is_int($claims['exp'] ?? null) || $claims['exp'] + $this->leewaySeconds < $now) {
            throw self::invalid('Token đã hết hạn');
        }
        if (is_int($claims['iat'] ?? null) && $claims['iat'] - $this->leewaySeconds > $now) {
            throw self::invalid('Token phát hành ở tương lai');
        }
        if (!is_string($claims['sub'] ?? null) || $claims['sub'] === '' || strlen($claims['sub']) > 255) {
            throw self::invalid('Thiếu sub');
        }
        return $claims;
    }

    /** Chuyển JWK RSA (n, e) sang PEM SubjectPublicKeyInfo */
    public static function jwkToPem(array $jwk): string
    {
        $n = self::b64urlDecode((string) $jwk['n']);
        $e = self::b64urlDecode((string) $jwk['e']);
        // INTEGER dương: bỏ byte 0 thừa, thêm lại 0x00 nếu bit cao được bật
        $int = static function (string $b): string {
            $b = ltrim($b, "\x00");
            if ($b === '' || (ord($b[0]) & 0x80)) {
                $b = "\x00" . $b;
            }
            return "\x02" . self::derLen(strlen($b)) . $b;
        };
        $rsaKey = $int($n) . $int($e);
        $rsaSeq = "\x30" . self::derLen(strlen($rsaKey)) . $rsaKey;
        $algId = "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00"; // rsaEncryption, NULL
        $bitStr = "\x03" . self::derLen(strlen($rsaSeq) + 1) . "\x00" . $rsaSeq;
        $spki = "\x30" . self::derLen(strlen($algId) + strlen($bitStr)) . $algId . $bitStr;
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    private static function derLen(int $len): string
    {
        if ($len < 0x80) {
            return chr($len);
        }
        $b = ltrim(pack('N', $len), "\x00");
        return chr(0x80 | strlen($b)) . $b;
    }

    public static function b64urlDecode(string $s): string
    {
        $d = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
        if ($d === false) {
            throw self::invalid('Base64 sai');
        }
        return $d;
    }

    /** @return array<string,mixed> */
    private static function jsonPart(string $p): array
    {
        $d = json_decode(self::b64urlDecode($p), true);
        if (!is_array($d)) {
            throw self::invalid('JSON sai');
        }
        return $d;
    }

    private static function invalid(string $why): ApiException
    {
        return new ApiException(401, 'INVALID_ID_TOKEN', "Google ID token không hợp lệ: $why");
    }

    /**
     * JWKS provider có cache file theo Cache-Control max-age của Google.
     * @return callable():array{keys:list<array<string,string>>}
     */
    public static function cachedJwks(string $cacheFile): callable
    {
        return static function () use ($cacheFile): array {
            if (is_file($cacheFile)) {
                $c = json_decode((string) file_get_contents($cacheFile), true);
                if (is_array($c) && ($c['expires'] ?? 0) > time()) {
                    return $c['jwks'];
                }
            }
            $ch = curl_init(self::JWKS_URL);
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5, CURLOPT_HEADER => true, CURLOPT_SSL_VERIFYPEER => true]);
            $raw = curl_exec($ch);
            if ($raw === false || curl_getinfo($ch, CURLINFO_RESPONSE_CODE) !== 200) {
                throw new ApiException(503, 'JWKS_UNAVAILABLE', 'Không tải được khóa Google');
            }
            $hs = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
            $headers = substr($raw, 0, $hs);
            $jwks = json_decode(substr($raw, $hs), true);
            $maxAge = preg_match('/max-age=(\d+)/i', $headers, $m) ? (int) $m[1] : 3600;
            @file_put_contents($cacheFile, json_encode(['expires' => time() + min($maxAge, 86400), 'jwks' => $jwks]), LOCK_EX);
            return $jwks;
        };
    }
}
