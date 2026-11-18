<?php
declare(strict_types=1);

namespace HolyMelody\Omr;

use HolyMelody\ApiException;
use HolyMelody\Config;
use HolyMelody\Db;

/**
 * AI đọc lại vùng nhận dạng khó (khi chuyển sang Editor): gửi ảnh cắt một dòng nhạc + MusicXML Audiveris đọc được
 * cho mô hình AI đọc ảnh, nhận lại MusicXML đã sửa. Chỉ dùng cho bản nhạc đã trả 10 credit chuyển đổi.
 * Ứng dụng KHÔNG tin mù quáng: chỉ thay ô nhịp khi Music Rule Validator cho kết quả ít lỗi hơn.
 *
 * Cấu hình: HM_ANTHROPIC_API_KEY (bắt buộc để bật), HM_AI_OMR_MODEL (mặc định claude-sonnet-5-5),
 * HM_AI_OMR_MAX_CALLS (số vùng tối đa mỗi bản nhạc, mặc định 24).
 */
final class OmrAiService
{
    private const ENDPOINT = 'https://api.anthropic.com/v1/messages';

    public function __construct(private Db $db, private Config $config)
    {
    }

    public function enabled(): bool
    {
        return (string) $this->config->get('HM_ANTHROPIC_API_KEY', '') !== '';
    }

    /**
     * @param array{source_hash?:string, image_png_base64?:string, musicxml?:string, measures?:list<int>, context?:array<string,mixed>} $in
     * @return array{musicxml:string, model:string}
     */
    public function rerecognize(int $userId, array $in): array
    {
        if (!$this->enabled()) {
            throw new ApiException(503, 'AI_UNAVAILABLE', 'Máy chủ chưa cấu hình AI nhận dạng (HM_ANTHROPIC_API_KEY)');
        }
        $hash = strtolower((string) ($in['source_hash'] ?? ''));
        $conv = $this->db->one('SELECT id FROM omr_conversions WHERE user_id = ? AND source_hash = ?', [$userId, $hash]);
        if (!$conv) {
            throw new ApiException(402, 'CONVERSION_REQUIRED', 'Cần chuyển bản nhạc sang Editor (10 credit) trước khi dùng AI');
        }
        $max = $this->config->int('HM_AI_OMR_MAX_CALLS', 24);
        $used = (int) ($this->db->one('SELECT COUNT(*) c FROM omr_ai_calls WHERE conversion_id = ?', [(int) $conv['id']])['c'] ?? 0);
        if ($used >= $max) {
            throw new ApiException(429, 'AI_QUOTA', "Đã dùng hết $max lượt AI cho bản nhạc này");
        }
        $png = base64_decode((string) ($in['image_png_base64'] ?? ''), true);
        if ($png === false || strlen($png) < 100 || strlen($png) > 8_000_000 || substr($png, 0, 8) !== "\x89PNG\r\n\x1a\n") {
            throw new ApiException(400, 'INVALID_IMAGE', 'Ảnh vùng không hợp lệ (PNG ≤ 8 MB)');
        }
        $xml = (string) ($in['musicxml'] ?? '');
        if ($xml === '' || strlen($xml) > 400_000 || !str_contains($xml, '<score-partwise')) {
            throw new ApiException(400, 'INVALID_MUSICXML', 'MusicXML không hợp lệ');
        }
        $measures = array_map('intval', array_slice((array) ($in['measures'] ?? []), 0, 32));
        $ctx = json_encode($in['context'] ?? [], JSON_UNESCAPED_UNICODE);
        $model = (string) $this->config->get('HM_AI_OMR_MODEL', 'claude-sonnet-5-5');

        $prompt = "Ảnh là MỘT dòng nhạc (system) cắt từ bản nhạc in/quét. Bên dưới là MusicXML mà phần mềm OMR (Audiveris) đọc được "
            . "cho đúng dòng nhạc này; các ô nhịp có số thứ tự (bắt đầu từ 1 trong dòng) " . json_encode($measures) . " bị nghi đọc sai "
            . "(sai trường độ, sót/thừa nốt, sai cao độ, dấu hoá, khoá nhạc hoặc hoá biểu). Ngữ cảnh: $ctx.\n"
            . "Nhiệm vụ: đối chiếu cẩn thận với ẢNH, sửa MusicXML cho đúng với ảnh. Giữ NGUYÊN số bè (part) và số ô nhịp, "
            . "giữ nguyên các ô đã đúng, giữ <divisions>, chỉ dùng phần tử MusicXML 4.0 chuẩn. Tổng trường độ mỗi ô phải khớp số chỉ nhịp "
            . "(trừ ô lấy đà). Không bịa nốt không có trong ảnh.\n"
            . "Chỉ trả về MỘT khối <score-partwise>…</score-partwise> hoàn chỉnh, không giải thích.\n\n" . $xml;

        $body = json_encode([
            'model' => $model,
            'max_tokens' => 16000,
            'messages' => [[
                'role' => 'user',
                'content' => [
                    ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => 'image/png', 'data' => base64_encode($png)]],
                    ['type' => 'text', 'text' => $prompt],
                ],
            ]],
        ], JSON_UNESCAPED_UNICODE);

        $ch = curl_init(self::ENDPOINT);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_HTTPHEADER => [
                'content-type: application/json',
                'anthropic-version: 2023-06-01',
                'x-api-key: ' . $this->config->get('HM_ANTHROPIC_API_KEY'),
            ],
            CURLOPT_POSTFIELDS => $body,
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $this->db->exec('INSERT INTO omr_ai_calls (conversion_id, model, http_status) VALUES (?, ?, ?)', [(int) $conv['id'], $model, $status]);
        if (!is_string($raw) || $status < 200 || $status >= 300) {
            throw new ApiException(502, 'AI_FAILED', "Dịch vụ AI lỗi (HTTP $status)");
        }
        $res = json_decode($raw, true);
        $text = '';
        foreach ((array) ($res['content'] ?? []) as $block) {
            if (($block['type'] ?? '') === 'text') {
                $text .= (string) $block['text'];
            }
        }
        $out = self::extractScore($text);
        if ($out === null) {
            throw new ApiException(502, 'AI_BAD_OUTPUT', 'AI không trả về MusicXML hợp lệ');
        }
        return ['musicxml' => $out, 'model' => $model];
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
