<?php
declare(strict_types=1);

namespace HolyMelody\Omr;

use HolyMelody\Ai\OpenAiClient;
use HolyMelody\ApiException;
use HolyMelody\Auth\Admins;
use HolyMelody\Config;
use HolyMelody\Db;

/**
 * AI (OpenAI) hỗ trợ nhận dạng khi chuyển sang Editor — chỉ cho bản nhạc đã trả phí chuyển đổi (admin: không giới hạn):
 *  - region: ảnh MỘT dòng nhạc + MusicXML Audiveris → MusicXML đã sửa (vùng khó);
 *  - review: như region nhưng rà soát toàn bộ dòng nhạc (lượt cuối, đối chiếu với bản gốc);
 *  - lyrics: đọc lời ca tiếng Việt dưới dòng nhạc → các lời (verse), mỗi lời là danh sách âm tiết.
 * Ứng dụng KHÔNG tin mù quáng: chỉ thay ô nhịp khi Music Rule Validator cho kết quả không tệ hơn.
 */
final class OmrAiService
{
    private OpenAiClient $ai;

    public function __construct(private Db $db, private Config $config)
    {
        $this->ai = new OpenAiClient($config);
    }

    public function enabled(): bool
    {
        return $this->ai->enabled();
    }

    /** @return array{conversion_id:int} */
    private function gate(int $userId, string $hash): array
    {
        if (!$this->ai->enabled()) {
            throw new ApiException(503, 'AI_UNAVAILABLE', 'Máy chủ chưa cấu hình AI (HM_OPENAI_API_KEY)');
        }
        $conv = $this->db->one('SELECT id FROM omr_conversions WHERE user_id = ? AND source_hash = ?', [$userId, strtolower($hash)]);
        if (!$conv) {
            throw new ApiException(402, 'CONVERSION_REQUIRED', 'Cần chuyển bản nhạc sang Editor trước khi dùng AI');
        }
        if (!Admins::is($this->db, $userId)) {
            $max = $this->config->int('HM_AI_OMR_MAX_CALLS', 60);
            $used = (int) ($this->db->one('SELECT COUNT(*) c FROM omr_ai_calls WHERE conversion_id = ?', [(int) $conv['id']])['c'] ?? 0);
            if ($used >= $max) {
                throw new ApiException(429, 'AI_QUOTA', "Đã dùng hết $max lượt AI cho bản nhạc này");
            }
        }
        return ['conversion_id' => (int) $conv['id']];
    }

    private static function png(mixed $b64): string
    {
        $png = base64_decode((string) $b64, true);
        if ($png === false || strlen($png) < 100 || strlen($png) > 8_000_000 || substr($png, 0, 8) !== "\x89PNG\r\n\x1a\n") {
            throw new ApiException(400, 'INVALID_IMAGE', 'Ảnh vùng không hợp lệ (PNG ≤ 8 MB)');
        }
        return $png;
    }

    private function log(int $convId, int $status): void
    {
        $this->db->exec('INSERT INTO omr_ai_calls (conversion_id, model, http_status) VALUES (?, ?, ?)', [$convId, $this->ai->model(), $status]);
    }

    /**
     * @param array<string,mixed> $in source_hash, image_png_base64, musicxml, measures, context, mode (region|review)
     * @return array{musicxml:string, model:string}
     */
    public function rerecognize(int $userId, array $in): array
    {
        $g = $this->gate($userId, (string) ($in['source_hash'] ?? ''));
        $png = self::png($in['image_png_base64'] ?? '');
        $xml = (string) ($in['musicxml'] ?? '');
        if ($xml === '' || strlen($xml) > 400_000 || !str_contains($xml, '<score-partwise')) {
            throw new ApiException(400, 'INVALID_MUSICXML', 'MusicXML không hợp lệ');
        }
        $review = ($in['mode'] ?? 'region') === 'review';
        $measures = array_map('intval', array_slice((array) ($in['measures'] ?? []), 0, 32));
        $ctx = json_encode($in['context'] ?? [], JSON_UNESCAPED_UNICODE);
        $instructions = 'Bạn là chuyên gia ký âm và nhận dạng bản nhạc (OMR). Bạn đối chiếu từng ký hiệu trên ẢNH với MusicXML và sửa cho '
            . 'khớp chính xác bản gốc. Chỉ trả về MỘT khối <score-partwise>…</score-partwise> MusicXML 4.0 hoàn chỉnh, không giải thích.';
        $text = "Ảnh là MỘT dòng nhạc (system) cắt từ bản nhạc in/quét. Bên dưới là MusicXML phần mềm OMR đọc được cho đúng dòng này.\n"
            . ($review
                ? "Rà soát TOÀN BỘ dòng cho GIỐNG HỆT bản gốc: cao độ, trường độ, chấm dôi, dấu lặng, dấu hoá (kể cả hoá biểu), dấu nối, dấu luyến, liên ba, khoá nhạc, số chỉ nhịp, phân bè và hướng đuôi nốt, ký hiệu hợp âm phía trên (<harmony>), sắc thái, dấu nhắc lại, lời ca (tiếng Việt có dấu, đúng âm tiết dưới từng nốt).\n"
                : 'Các ô nhịp (số thứ tự trong dòng, bắt đầu từ 1) ' . json_encode($measures) . " bị nghi đọc sai (trường độ, sót/thừa nốt, cao độ, dấu hoá, khoá, hoá biểu).\n")
            . "Ngữ cảnh: $ctx.\nYêu cầu: giữ NGUYÊN số bè (part) và số ô nhịp; giữ <divisions>; tổng trường độ mỗi ô khớp số chỉ nhịp (trừ ô lấy đà); "
            . "không bịa ký hiệu không có trong ảnh; giữ các phần đã đúng.\n\n$xml";
        try {
            $out = $this->ai->vision($instructions, $text, [$png]);
        } catch (ApiException $e) {
            $this->log($g['conversion_id'], $e->status);
            throw $e;
        }
        $this->log($g['conversion_id'], 200);
        $score = self::extractScore($out) ?? throw new ApiException(502, 'AI_BAD_OUTPUT', 'AI không trả về MusicXML hợp lệ');
        return ['musicxml' => $score, 'model' => $this->ai->model()];
    }

    /**
     * Đọc lời ca của một dòng nhạc. `notes` = số nốt (không tính nốt nối) của bè giai điệu trong dòng, để AI tách âm tiết đúng.
     * @param array<string,mixed> $in source_hash, image_png_base64, notes, verses_hint
     * @return array{verses: list<list<string>>, model:string}
     */
    public function lyrics(int $userId, array $in): array
    {
        $g = $this->gate($userId, (string) ($in['source_hash'] ?? ''));
        $png = self::png($in['image_png_base64'] ?? '');
        $notes = max(0, min(400, (int) ($in['notes'] ?? 0)));
        $instructions = 'Bạn đọc lời ca tiếng Việt in dưới khuông nhạc. Trả về JSON thuần, không giải thích.';
        $text = "Ảnh là MỘT dòng nhạc. Hãy đọc lời ca in dưới (hoặc giữa) các khuông, đúng dấu tiếng Việt.\n"
            . "Nếu có nhiều lời (lời 1, lời 2… xếp chồng), trả mỗi lời riêng theo thứ tự từ trên xuống.\n"
            . "Tách theo ÂM TIẾT đúng như in dưới từng nốt (mỗi âm tiết một phần tử; giữ dấu câu dính vào âm tiết trước; bỏ số thứ tự lời như \"1.\").\n"
            . ($notes ? "Bè giai điệu của dòng này có khoảng $notes nốt (mỗi nốt thường một âm tiết; nốt luyến không có âm tiết mới).\n" : '')
            . 'Định dạng: {"verses":[["Lạy","Chúa","con"],["…"]]}. Không có lời thì {"verses":[]}.';
        try {
            $out = $this->ai->vision($instructions, $text, [$png], 4000);
        } catch (ApiException $e) {
            $this->log($g['conversion_id'], $e->status);
            throw $e;
        }
        $this->log($g['conversion_id'], 200);
        $a = strpos($out, '{');
        $b = strrpos($out, '}');
        $json = $a !== false && $b !== false ? json_decode(substr($out, $a, $b - $a + 1), true) : null;
        $verses = [];
        foreach ((array) ($json['verses'] ?? []) as $v) {
            $syl = array_values(array_filter(array_map(fn ($s) => mb_substr(trim((string) $s), 0, 40), (array) $v), fn ($s) => $s !== ''));
            if ($syl) {
                $verses[] = array_slice($syl, 0, 600);
            }
        }
        return ['verses' => array_slice($verses, 0, 8), 'model' => $this->ai->model()];
    }

    /** Lấy khối <score-partwise> từ câu trả lời (bỏ ``` và chữ thừa); kiểm tra XML hợp lệ */
    public static function extractScore(string $text): ?string
    {
        $a = strpos($text, '<score-partwise');
        $b = strrpos($text, '</score-partwise>');
        if ($a === false || $b === false || $b < $a) {
            return null;
        }
        $xml = '<?xml version="1.0" encoding="UTF-8"?>' . "\n" . substr($text, $a, $b - $a + strlen('</score-partwise>'));
        $prev = libxml_use_internal_errors(true);
        $doc = simplexml_load_string($xml, 'SimpleXMLElement', LIBXML_NONET);
        libxml_use_internal_errors($prev);
        return $doc === false ? null : $xml;
    }
}
