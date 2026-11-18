<?php
declare(strict_types=1);

namespace HolyMelody\Singer;

use HolyMelody\Ai\OpenAiClient;
use HolyMelody\ApiException;
use HolyMelody\Auth\Admins;
use HolyMelody\Config;
use HolyMelody\Db;
use HolyMelody\Wallet\WalletService;

/**
 * AI Singer — giọng đọc từng ÂM TIẾT bằng OpenAI TTS; ứng dụng tự kéo cao độ/độ dài cho khớp từng nốt (PSOLA).
 * Âm tiết được lưu đệm trên máy chủ (theo giọng + mô hình) nên bài sau dùng lại, nhanh và rẻ hơn.
 * Mỗi lượt dựng giọng: 10 credit (ai_pricing 'singer_render'), một lần theo Idempotency-Key; admin miễn phí.
 */
final class SingerService
{
    private const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

    public function __construct(private Db $db, private Config $config, private WalletService $wallet)
    {
    }

    public function enabled(): bool
    {
        return (new OpenAiClient($this->config))->enabled();
    }

    /** @return array{voices:list<string>, enabled:bool, credits:int} */
    public function info(): array
    {
        $row = $this->db->one("SELECT credit_cost FROM ai_pricing WHERE job_type = 'singer_render'");
        return ['voices' => self::VOICES, 'enabled' => $this->enabled(), 'credits' => $row ? (int) $row['credit_cost'] : 10];
    }

    /**
     * @param array{syllables?:list<string>, voice?:string, style?:string} $in
     * @return array{voice:string, items:array<string,string>, missing:list<string>, credits:int, replayed:bool}
     */
    public function renderVoice(int $userId, array $in, string $idempotencyKey): array
    {
        $ai = new OpenAiClient($this->config);
        if (!$ai->enabled()) {
            throw new ApiException(503, 'AI_UNAVAILABLE', 'Máy chủ chưa cấu hình OpenAI (HM_OPENAI_API_KEY)');
        }
        $voice = in_array($in['voice'] ?? '', self::VOICES, true) ? (string) $in['voice'] : 'coral';
        $syl = [];
        foreach ((array) ($in['syllables'] ?? []) as $s) {
            $s = mb_strtolower(trim(preg_replace('/[^\p{L}\p{M}\']+/u', '', (string) $s) ?? ''));
            if ($s !== '' && mb_strlen($s) <= 20) {
                $syl[$s] = true;
            }
        }
        $syl = array_keys($syl);
        if (!$syl || count($syl) > 500) {
            throw new ApiException(400, 'INVALID_SYLLABLES', 'Cần từ 1 đến 500 âm tiết khác nhau');
        }
        $style = mb_substr((string) ($in['style'] ?? ''), 0, 200);
        $instructions = 'Đọc DUY NHẤT một âm tiết tiếng Việt, phát âm chuẩn, rõ dấu, giọng hát ấm và tròn, ngân dài nguyên âm khoảng một giây, '
            . 'không thêm từ nào khác, không ngắt hơi giữa chừng.' . ($style !== '' ? " Phong cách: $style." : '');

        // ---- trừ credit một lần (bản ghi ai_jobs hoàn tất ngay; Idempotency-Key chống trừ hai lần)
        $admin = Admins::is($this->db, $userId);
        $cost = $admin ? 0 : $this->info()['credits'];
        [$jobId, $replayed] = $this->db->tx(function (Db $db) use ($userId, $idempotencyKey, $cost, $voice, $syl) {
            $ex = $db->one('SELECT id FROM ai_jobs WHERE user_id = ? AND idempotency_key = ?', [$userId, $idempotencyKey]);
            if ($ex) {
                return [(int) $ex['id'], true];
            }
            $db->exec("INSERT INTO ai_jobs (user_id, job_type, input_reference, params, status, credit_cost, provider, idempotency_key) VALUES (?, 'singer_render', '', ?, 'processing', ?, 'openai', ?)",
                [$userId, json_encode(['voice' => $voice, 'syllables' => count($syl)]), $cost, $idempotencyKey]);
            $id = $db->lastId();
            if ($cost > 0) {
                $this->wallet->apply($userId, -$cost, 'ai_charge', 'ai_job', $id, "ai_job:$id:charge", 'AI Singer');
            }
            return [$id, false];
        });

        // ---- âm tiết: lấy từ bộ đệm, còn thiếu thì gọi OpenAI song song
        $model = (string) ($this->config->get('HM_OPENAI_TTS_MODEL') ?: 'gpt-4o-mini-tts');
        $dir = rtrim((string) ($this->config->get('HM_STORAGE_DIR') ?: sys_get_temp_dir()), '/') . '/singer-cache';
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        $file = fn (string $s) => $dir . '/' . sha1("$model|$voice|$style|$s") . '.wav';
        $items = [];
        $need = [];
        foreach ($syl as $s) {
            $f = $file($s);
            if (is_file($f) && filesize($f) > 100) {
                $items[$s] = base64_encode((string) file_get_contents($f));
            } else {
                $need[$s] = $s;
            }
        }
        if ($need) {
            foreach ($ai->speechMany($need, $instructions, $voice) as $s => $wav) {
                if ($wav !== null && strlen($wav) > 100 && str_starts_with($wav, 'RIFF')) {
                    @file_put_contents($file($s), $wav);
                    $items[$s] = base64_encode($wav);
                }
            }
        }
        $missing = array_values(array_diff($syl, array_keys($items)));
        // lỗi quá nhiều → hoàn credit (một lần)
        if (count($missing) > max(2, (int) (count($syl) * 0.2))) {
            if ($cost > 0 && !$replayed) {
                $this->wallet->apply($userId, $cost, 'ai_refund', 'ai_job', $jobId, "ai_job:$jobId:refund", 'Hoàn credit AI Singer');
            }
            $this->db->exec("UPDATE ai_jobs SET status = 'failed' WHERE id = ?", [$jobId]);
            throw new ApiException(502, 'AI_FAILED', 'OpenAI không tạo được giọng cho nhiều âm tiết; đã hoàn credit');
        }
        $this->db->exec("UPDATE ai_jobs SET status = 'completed', progress = 100 WHERE id = ?", [$jobId]);
        return ['voice' => $voice, 'items' => $items, 'missing' => $missing, 'credits' => $cost, 'replayed' => $replayed];
    }
}
