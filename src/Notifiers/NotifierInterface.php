<?php

declare(strict_types=1);

namespace SmartRelay\Notifiers;

/**
 * Contract for all notification channels (Telegram, Email, SMS, Webhook).
 *
 * Adding a new channel = implementing this interface.
 * The AlertService and MaintenanceService don't care which channel is used —
 * they just call send() on whatever notifiers are configured.
 */
interface NotifierInterface
{
    /**
     * Unique channel identifier. Example: 'telegram', 'email', 'sms_ro'
     */
    public function getId(): string;

    /**
     * Returns true if the notifier is configured and ready to send.
     */
    public function isConfigured(): bool;

    /**
     * Send a notification.
     *
     * @param string $subject  Short summary (used as title/subject line)
     * @param string $body     Full message body (markdown supported where applicable)
     * @param string $level    'info' | 'warning' | 'critical'
     * @param array  $metadata Optional extra data (recipient override, tags, etc.)
     *
     * @return array ['success' => bool, 'message' => string]
     */
    public function send(
        string $subject,
        string $body,
        string $level = 'info',
        array $metadata = []
    ): array;
}
