<?php
declare(strict_types=1);

namespace HolyMelody\Ai;

use HolyMelody\ApiException;
use HolyMelody\Config;

/**
 * Gọi OpenAI từ máy chủ (API key không bao giờ nằm trong app).
 *  - vision(): Responses API, ảnh PNG + văn bản → văn bản (MusicXML / JSON)
 *  - speech(): /v1/audio/speech → âm thanh WAV
 * Cấu hình: HM_OPENAI_API_KEY, HM_OPENAI_MODEL (mặc định gpt-5.6-sol), HM_OPENAI_TTS_MODEL (mặc định gpt-4o-mini-tts),
 * HM_OPENAI_TTS_VOICE (mặc định coral), HM_OPENAI_BASE_URL (mặc định https://api.openai.com/v1).
 */
final class OpenAiClient
{
    public function __construct(private Config $config)
    {
    }

    public function enabled(): bool
    {
        return (string) $this->config->get('HM_OPENAI_API_KEY', '') !== '';
    }

    public function model(): string
    {
        return (string) ($this->config->get('HM_OPENAI_MODEL') ?: 'gpt-5.6-sol');
    }

    private function base(): string
    {
        return rtrim((string) ($this->config->get('HM_OPENAI_BASE_URL') ?: 'https://api.openai.com/v1'), '/');
    }

    private function require(): void
    {
        if (!$this->enabled()) {
            throw new ApiException(503, 'AI_UNAVAILABLE', 'Máy chủ chưa cấu hình OpenAI (HM_OPENAI_API_KEY)');
        }
    }

    /**
     * @param list<string> $pngImages ảnh PNG (bytes)
     */
    public function vision(string $instructions, string $text, array $pngImages, int $maxOutputTokens = 16000): string
    {
        $this->require();
        $content = [['type' => 'input_text', 'text' => $text]];
        foreach ($pngImages as $png) {
            $content[] = ['type' => 'input_image', 'image_url' => 'data:image/png;base64,' . base64_encode($png), 'detail' => 'high'];
        }
        $res = $this->post('/responses', [
            'model' => $this->model(),
            'instructions' => $instructions,
            'input' => [['role' => 'user', 'content' => $content]],
            'max_output_tokens' => $maxOutputTokens,
        ], 180);
        $json = json_decode($res, true);
        $out = '';
        foreach ((array) ($json['output'] ?? []) as $item) {
            foreach ((array) ($item['content'] ?? []) as $c) {
                if (($c['type'] ?? '') === 'output_text') {
                    $out .= (string) $c['text'];
                }
            }
        }
        if ($out === '' && isset($json['output_text'])) {
            $out = (string) $json['output_text'];
        }
        if ($out === '') {
            throw new ApiException(502, 'AI_BAD_OUTPUT', 'OpenAI không trả về nội dung');
        }
        return $out;
    }

    /** Văn bản → WAV (mono). `instructions` điều khiển giọng (chỉ gpt-4o-mini-tts). */
    public function speech(string $input, string $instructions = '', ?string $voice = null): string
    {
        $this->require();
        $model = (string) ($this->config->get('HM_OPENAI_TTS_MODEL') ?: 'gpt-4o-mini-tts');
        $body = ['model' => $model, 'input' => $input, 'voice' => $voice ?: (string) ($this->config->get('HM_OPENAI_TTS_VOICE') ?: 'coral'), 'response_format' => 'wav'];
        if ($instructions !== '' && str_starts_with($model, 'gpt-')) {
            $body['instructions'] = $instructions;
        }
        return $this->post('/audio/speech', $body, 60);
    }

    /**
     * Nhiều yêu cầu speech song song (curl_multi) — dùng cho AI Singer (mỗi âm tiết một đoạn).
     * @param array<string,string> $inputs khoá → văn bản
     * @return array<string,string|null> khoá → WAV (null nếu lỗi)
     */
    public function speechMany(array $inputs, string $instructions, ?string $voice = null, int $concurrency = 8): array
    {
        $this->require();
        $model = (string) ($this->config->get('HM_OPENAI_TTS_MODEL') ?: 'gpt-4o-mini-tts');
        $voice = $voice ?: (string) ($this->config->get('HM_OPENAI_TTS_VOICE') ?: 'coral');
        $out = [];
        $queue = $inputs;
        $mh = curl_multi_init();
        $active = [];
        $start = function () use (&$queue, &$active, $mh, $model, $voice, $instructions, $concurrency) {
            while ($queue && count($active) < $concurrency) {
                $key = (string) array_key_first($queue);
                $text = $queue[$key];
                unset($queue[$key]);
                $body = ['model' => $model, 'input' => $text, 'voice' => $voice, 'response_format' => 'wav'];
                if ($instructions !== '' && str_starts_with($model, 'gpt-')) {
                    $body['instructions'] = $instructions;
                }
                $ch = $this->handle('/audio/speech', $body, 60);
                curl_multi_add_handle($mh, $ch);
                $active[(int) curl_getinfo($ch, CURLINFO_PRIVATE)] = [$ch, $key];
            }
        };
        $start();
        do {
            curl_multi_exec($mh, $running);
            curl_multi_select($mh, 1.0);
            while ($info = curl_multi_info_read($mh)) {
                $ch = $info['handle'];
                $id = (int) curl_getinfo($ch, CURLINFO_PRIVATE);
                [, $key] = $active[$id];
                $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
                $out[$key] = $code >= 200 && $code < 300 ? (string) curl_multi_getcontent($ch) : null;
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
                unset($active[$id]);
                $start();
            }
        } while ($running || $active || $queue);
        curl_multi_close($mh);
        return $out;
    }

    private static int $seq = 0;

    /** @param array<string,mixed> $body */
    private function handle(string $path, array $body, int $timeout): \CurlHandle
    {
        $ch = curl_init($this->base() . $path);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_PRIVATE => (string) ++self::$seq,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $this->config->get('HM_OPENAI_API_KEY')],
            CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE),
        ]);
        return $ch;
    }

    /** @param array<string,mixed> $body */
    private function post(string $path, array $body, int $timeout): string
    {
        $ch = $this->handle($path, $body, $timeout);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if (!is_string($raw) || $status < 200 || $status >= 300) {
            $msg = is_string($raw) ? (string) (json_decode($raw, true)['error']['message'] ?? '') : '';
            throw new ApiException(502, 'AI_FAILED', "OpenAI lỗi (HTTP $status)" . ($msg !== '' ? ': ' . mb_substr($msg, 0, 160) : ''));
        }
        return $raw;
    }
}
