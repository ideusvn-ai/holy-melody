<?php
declare(strict_types=1);

namespace HolyMelody\Auth;

use HolyMelody\Db;

/** Tài khoản quản trị: dùng mọi tính năng không bị giới hạn credit / lượt AI */
final class Admins
{
    /** @var array<int,bool> */
    private static array $cache = [];

    public static function is(Db $db, int $userId): bool
    {
        return self::$cache[$userId] ??= (bool) $db->one('SELECT 1 AS a FROM admin_users WHERE user_id = ?', [$userId]);
    }
}
