<?php

declare(strict_types=1);

namespace SmartRelay\Tests\Unit\Notifiers;

use PHPUnit\Framework\TestCase;
use SmartRelay\Core\Config;
use SmartRelay\Notifiers\TelegramNotifier;

class TelegramNotifierTest extends TestCase
{
    protected function setUp(): void
    {
        Config::reset();
    }

    protected function tearDown(): void
    {
        Config::reset();
        putenv('TELEGRAM_BOT_TOKEN');
        putenv('TELEGRAM_CHAT_ID');
    }

    public function testGetIdReturnsTelegram(): void
    {
        $notifier = new TelegramNotifier();
        $this->assertSame('telegram', $notifier->getId());
    }

    public function testIsConfiguredReturnsFalseWhenTokenMissing(): void
    {
        putenv('TELEGRAM_CHAT_ID=123456');
        $notifier = new TelegramNotifier();
        $this->assertFalse($notifier->isConfigured());
    }

    public function testIsConfiguredReturnsFalseWhenChatIdMissing(): void
    {
        putenv('TELEGRAM_BOT_TOKEN=bot123:abc');
        $notifier = new TelegramNotifier();
        $this->assertFalse($notifier->isConfigured());
    }

    public function testIsConfiguredReturnsTrueWhenBothSet(): void
    {
        putenv('TELEGRAM_BOT_TOKEN=bot123:abc');
        putenv('TELEGRAM_CHAT_ID=-100123456');
        $notifier = new TelegramNotifier();
        $this->assertTrue($notifier->isConfigured());
    }

    public function testSendReturnsFailureWhenNotConfigured(): void
    {
        $notifier = new TelegramNotifier();
        $result   = $notifier->send('Test', 'Body');
        $this->assertFalse($result['success']);
        $this->assertStringContainsString('not configured', $result['message']);
    }
}
