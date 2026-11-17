<?php
declare(strict_types=1);

namespace HolyMelody;

/** Lỗi trả về client với mã HTTP + mã lỗi ổn định. */
class ApiException extends \RuntimeException
{
    /** @param array<string,mixed> $details */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $details = [],
    ) {
        parent::__construct($message);
    }
}

final class NotConfiguredException extends ApiException
{
    public function __construct(string $message)
    {
        parent::__construct(503, 'NOT_CONFIGURED', $message);
    }
}

final class InsufficientCreditsException extends ApiException
{
    public function __construct(int $balance, int $required)
    {
        parent::__construct(402, 'INSUFFICIENT_CREDITS', 'Không đủ credit', ['balance' => $balance, 'required' => $required]);
    }
}
