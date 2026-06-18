<?php

declare(strict_types=1);

namespace SmartRelay\Notifiers;

use SmartRelay\Core\Config;
use SmartRelay\Core\Logger;

/**
 * Sends notifications via Telegram Bot API.
 *
 * Required config keys:
 *   TELEGRAM_BOT_TOKEN  — bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — target chat/channel ID
 *
 * Supports multiple chat IDs (comma-separated) for broadcasting
 * to both the regional alert channel and the CMMS admin group.
 */
class TelegramNotifier implements NotifierInterface
{
    private const API_BASE = 'https://api.telegram.org/bot';
    private const TIMEOUT  = 10;

    private Logger $logger;

    public function __construct(?Logger $logger = null)
    {
        $this->logger = $logger ?? new Logger('telegram');
    }

    public function getId(): string
    {
        return 'telegram';
    }

    public function isConfigured(): bool
    {
        return Config::has('TELEGRAM_BOT_TOKEN') && Config::has('TELEGRAM_CHAT_ID');
    }

    public function send(
        string $subject,
        string $body,
        string $level = 'info',
        array $metadata = []
    ): array {
        if (!$this->isConfigured()) {
            return ['success' => false, 'message' => 'Telegram not configured'];
        }

        $icon    = $this->levelIcon($level);
        $message = "{$icon} *{$subject}*\n\n{$body}";

        $chatIds = array_map('trim', explode(',', Config::get('TELEGRAM_CHAT_ID')));
        $errors  = [];

        foreach ($chatIds as $chatId) {
            $result = $this->sendToChat($chatId, $message);
            if (!$result['success']) {
                $errors[] = $result['message'];
            }
        }

        if (!empty($errors)) {
            $this->logger->error('Telegram send errors', ['errors' => $errors]);
            return ['success' => false, 'message' => implode('; ', $errors)];
        }

        $this->logger->info('Telegram notification sent', [
            'subject'  => $subject,
            'level'    => $level,
            'channels' => count($chatIds),
        ]);

        return ['success' => true, 'message' => 'Sent to ' . count($chatIds) . ' channel(s)'];
    }

    private function sendToChat(string $chatId, string $text): array
    {
        $token   = Config::get('TELEGRAM_BOT_TOKEN');
        $url     = self::API_BASE . $token . '/sendMessage';
        $payload = json_encode([
            'chat_id'    => $chatId,
            'text'       => $text,
            'parse_mode' => 'Markdown',
        ]);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => self::TIMEOUT,
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error    = curl_error($ch);
        curl_close($ch);

        if ($error) {
            return ['success' => false, 'message' => "cURL error: {$error}"];
        }

        $data = json_decode($response, true);
        if ($httpCode !== 200 || empty($data['ok'])) {
            $desc = $data['description'] ?? 'Unknown error';
            return ['success' => false, 'message' => "API error ({$httpCode}): {$desc}"];
        }

        return ['success' => true, 'message' => 'ok'];
    }

    private function levelIcon(string $level): string
    {
        return match ($level) {
            'critical' => '🚨',
            'warning'  => '⚠️',
            'info'     => 'ℹ️',
            default    => '📢',
        };
    }
}
