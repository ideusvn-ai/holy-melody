<?php
declare(strict_types=1);

namespace HolyMelody;

use mysqli;
use mysqli_sql_exception;

/**
 * Lớp mỏng trên MySQLi: chỉ prepared statements, transaction có retry khi deadlock.
 */
final class Db
{
    public const ER_DUP_ENTRY = 1062;
    private const ER_LOCK_DEADLOCK = 1213;
    private const ER_LOCK_WAIT_TIMEOUT = 1205;

    private int $depth = 0;

    public function __construct(public readonly mysqli $conn)
    {
        $conn->set_charset('utf8mb4');
        $conn->query("SET time_zone = '+00:00'");
        $conn->query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    }

    public static function connect(Config $c): self
    {
        $m = new mysqli(
            $c->require('HM_DB_HOST'),
            $c->require('HM_DB_USER'),
            $c->get('HM_DB_PASS', '') ?? '',
            $c->require('HM_DB_NAME'),
            $c->int('HM_DB_PORT', 3306),
        );
        return new self($m);
    }

    /** @param list<mixed> $params */
    public function exec(string $sql, array $params = []): int
    {
        $st = $this->conn->prepare($sql);
        if ($params) {
            $st->bind_param(self::types($params), ...$params);
        }
        $st->execute();
        $n = $st->affected_rows;
        $st->close();
        return (int) $n;
    }

    /**
     * @param list<mixed> $params
     * @return list<array<string,mixed>>
     */
    public function all(string $sql, array $params = []): array
    {
        $st = $this->conn->prepare($sql);
        if ($params) {
            $st->bind_param(self::types($params), ...$params);
        }
        $st->execute();
        $res = $st->get_result();
        $rows = $res ? $res->fetch_all(MYSQLI_ASSOC) : [];
        $st->close();
        return $rows;
    }

    /**
     * @param list<mixed> $params
     * @return array<string,mixed>|null
     */
    public function one(string $sql, array $params = []): ?array
    {
        return $this->all($sql, $params)[0] ?? null;
    }

    public function lastId(): int
    {
        return (int) $this->conn->insert_id;
    }

    /**
     * Chạy $fn trong transaction. Deadlock/lock-timeout → rollback và thử lại (tối đa 3 lần).
     * Transaction lồng nhau dùng chung transaction ngoài.
     * @template T
     * @param callable(self):T $fn
     * @return T
     */
    public function tx(callable $fn): mixed
    {
        if ($this->depth > 0) {
            return $fn($this);
        }
        for ($attempt = 1; ; $attempt++) {
            $this->conn->begin_transaction();
            $this->depth = 1;
            try {
                $result = $fn($this);
                $this->conn->commit();
                $this->depth = 0;
                return $result;
            } catch (\Throwable $e) {
                $this->conn->rollback();
                $this->depth = 0;
                $code = $e instanceof mysqli_sql_exception ? $e->getCode() : 0;
                if (in_array($code, [self::ER_LOCK_DEADLOCK, self::ER_LOCK_WAIT_TIMEOUT], true) && $attempt < 3) {
                    usleep(20000 * $attempt);
                    continue;
                }
                throw $e;
            }
        }
    }

    public static function isDuplicate(\Throwable $e): bool
    {
        return $e instanceof mysqli_sql_exception && $e->getCode() === self::ER_DUP_ENTRY;
    }

    /** @param list<mixed> $params */
    private static function types(array $params): string
    {
        $t = '';
        foreach ($params as $p) {
            $t .= is_int($p) || is_bool($p) ? 'i' : (is_float($p) ? 'd' : 's');
        }
        return $t;
    }
}
