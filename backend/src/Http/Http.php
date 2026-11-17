<?php
declare(strict_types=1);

namespace HolyMelody\Http;

use HolyMelody\ApiException;

final class Request
{
    /** @var array<string,string> */
    public array $params = [];
    public ?array $auth = null;

    /**
     * @param array<string,string> $headers khóa viết thường
     * @param array<string,string> $query
     * @param array<string,string> $cookies
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $headers,
        public readonly array $query,
        public readonly string $body,
        public readonly array $cookies = [],
        public readonly string $ip = '',
    ) {
    }

    public static function fromGlobals(): self
    {
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = (string) $_SERVER['CONTENT_TYPE'];
        }
        $path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
        return new self(
            strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
            rtrim($path, '/') ?: '/',
            $headers,
            array_map('strval', $_GET),
            (string) file_get_contents('php://input'),
            array_map('strval', $_COOKIE),
            (string) ($_SERVER['REMOTE_ADDR'] ?? ''),
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /** @return array<string,mixed> */
    public function json(): array
    {
        if ($this->body === '') {
            return [];
        }
        try {
            $d = json_decode($this->body, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiException(400, 'INVALID_JSON', 'Body không phải JSON hợp lệ');
        }
        if (!is_array($d)) {
            throw new ApiException(400, 'INVALID_JSON', 'Body phải là object JSON');
        }
        return $d;
    }

    public function bearer(): ?string
    {
        $h = $this->header('authorization');
        if ($h && preg_match('/^Bearer\s+([A-Za-z0-9_\-]{20,200})$/', $h, $m)) {
            return $m[1];
        }
        return null;
    }
}

final class Response
{
    /** @param array<string,string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public array $headers = ['Content-Type' => 'application/json; charset=utf-8'],
    ) {
    }

    public static function json(mixed $data, int $status = 200): self
    {
        return new self($status, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    }

    public static function error(ApiException $e): self
    {
        return self::json(['error' => ['code' => $e->errorCode, 'message' => $e->getMessage()] + ($e->details ? ['details' => $e->details] : [])], $e->status);
    }

    public function send(): void
    {
        http_response_code($this->status);
        $sec = [
            'X-Content-Type-Options' => 'nosniff',
            'Referrer-Policy' => 'no-referrer',
            'Cache-Control' => 'no-store',
            'Strict-Transport-Security' => 'max-age=31536000; includeSubDomains',
        ];
        foreach ($this->headers + $sec as $k => $v) {
            header("$k: $v");
        }
        echo $this->body;
    }
}

final class Router
{
    /** @var list<array{string,string,callable,list<callable>}> */
    private array $routes = [];

    /** @param list<callable(Request):void> $middleware */
    public function add(string $method, string $pattern, callable $handler, array $middleware = []): void
    {
        $this->routes[] = [$method, $pattern, $handler, $middleware];
    }

    public function dispatch(Request $req): Response
    {
        $allowed = [];
        foreach ($this->routes as [$method, $pattern, $handler, $mw]) {
            $regex = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[A-Za-z0-9_\-]+)', $pattern) . '$#';
            if (!preg_match($regex, $req->path, $m)) {
                continue;
            }
            if ($method !== $req->method) {
                $allowed[] = $method;
                continue;
            }
            $req->params = array_filter($m, 'is_string', ARRAY_FILTER_USE_KEY);
            try {
                foreach ($mw as $f) {
                    $f($req);
                }
                $res = $handler($req);
                return $res instanceof Response ? $res : Response::json($res);
            } catch (ApiException $e) {
                return Response::error($e);
            }
        }
        if ($allowed) {
            return Response::error(new ApiException(405, 'METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ'));
        }
        return Response::error(new ApiException(404, 'NOT_FOUND', 'Không tìm thấy'));
    }
}
