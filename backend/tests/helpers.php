<?php
declare(strict_types=1);

use HolyMelody\Auth\GoogleIdTokenVerifier;

/** Khóa RSA thử nghiệm + JWKS giả lập Google */
final class TestKeys
{
    private static ?array $k = null;

    /** @return array{priv:\OpenSSLAsymmetricKey, jwks:array, kid:string} */
    public static function get(): array
    {
        if (self::$k) {
            return self::$k;
        }
        $priv = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        $d = openssl_pkey_get_details($priv)['rsa'];
        $b64 = static fn (string $s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
        $kid = 'test-kid-1';
        return self::$k = ['priv' => $priv, 'kid' => $kid, 'jwks' => ['keys' => [['kty' => 'RSA', 'alg' => 'RS256', 'use' => 'sig', 'kid' => $kid, 'n' => $b64($d['n']), 'e' => $b64($d['e'])]]]];
    }

    public static function token(array $claims, array $header = []): string
    {
        $k = self::get();
        $b64 = static fn (string $s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
        $h = $b64(json_encode($header + ['alg' => 'RS256', 'kid' => $k['kid'], 'typ' => 'JWT']));
        $p = $b64(json_encode($claims));
        openssl_sign("$h.$p", $sig, $k['priv'], OPENSSL_ALGO_SHA256);
        return "$h.$p." . $b64($sig);
    }

    public static function claims(array $over = []): array
    {
        return $over + [
            'iss' => 'https://accounts.google.com', 'aud' => 'web-client.apps.googleusercontent.com', 'sub' => '1234567890',
            'email' => 'tester@example.com', 'email_verified' => true, 'name' => 'Người Thử', 'iat' => 1_700_000_000, 'exp' => 1_700_003_600,
        ];
    }

    public static function verifier(int $now = 1_700_000_100): GoogleIdTokenVerifier
    {
        return new GoogleIdTokenVerifier(['web-client.apps.googleusercontent.com', 'desktop-client.apps.googleusercontent.com'], fn () => self::get()['jwks'], 60, fn () => $now);
    }
}
