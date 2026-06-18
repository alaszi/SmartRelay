<?php

declare(strict_types=1);

namespace SmartRelay\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use SmartRelay\Collectors\CollectorInterface;
use SmartRelay\Notifiers\NotifierInterface;
use SmartRelay\Services\AlertService;

class AlertServiceTest extends TestCase
{
    public function testGetName(): void
    {
        $service = new AlertService();
        $this->assertSame('Regional Alert Service', $service->getName());
    }

    public function testIsNotReadyWithNoCollectors(): void
    {
        $service = new AlertService();
        $service->registerNotifier($this->makeNotifier());
        $this->assertFalse($service->isReady());
    }

    public function testIsNotReadyWithNoNotifiers(): void
    {
        $service = new AlertService();
        $service->registerCollector($this->makeCollector());
        $this->assertFalse($service->isReady());
    }

    public function testIsReadyWithBoth(): void
    {
        $service = new AlertService();
        $service->registerCollector($this->makeCollector());
        $service->registerNotifier($this->makeNotifier());
        $this->assertTrue($service->isReady());
    }

    public function testExecuteReturnsSuccessArray(): void
    {
        $service = new AlertService();
        $service->registerCollector($this->makeCollector());
        $service->registerNotifier($this->makeNotifier());

        $result = $service->execute();

        $this->assertTrue($result['success']);
        $this->assertArrayHasKey('collectors', $result);
        $this->assertArrayHasKey('alerts', $result);
        $this->assertArrayHasKey('sent', $result);
    }

    public function testRuleTriggersNotification(): void
    {
        $notified = false;
        $notifier = $this->getMockBuilder(NotifierInterface::class)->getMock();
        $notifier->method('getId')->willReturn('mock');
        $notifier->method('isConfigured')->willReturn(true);
        $notifier->method('send')->willReturnCallback(function () use (&$notified) {
            $notified = true;
            return ['success' => true, 'message' => 'ok'];
        });

        $service = new AlertService();
        $service->registerCollector($this->makeCollector());
        $service->registerNotifier($notifier);
        $service->registerRule('always_alert', fn($data) => [
            'subject' => 'Test alert',
            'body'    => 'Always triggers',
            'level'   => 'info',
        ]);

        $service->execute();
        $this->assertTrue($notified);
    }

    public function testRuleReturningNullDoesNotNotify(): void
    {
        $notified = false;
        $notifier = $this->getMockBuilder(NotifierInterface::class)->getMock();
        $notifier->method('getId')->willReturn('mock');
        $notifier->method('isConfigured')->willReturn(true);
        $notifier->method('send')->willReturnCallback(function () use (&$notified) {
            $notified = true;
            return ['success' => true, 'message' => 'ok'];
        });

        $service = new AlertService();
        $service->registerCollector($this->makeCollector());
        $service->registerNotifier($notifier);
        $service->registerRule('never_alert', fn($data) => null);

        $service->execute();
        $this->assertFalse($notified);
    }

    // --- Helpers ---

    private function makeCollector(string $id = 'mock_collector'): CollectorInterface
    {
        $collector = $this->getMockBuilder(CollectorInterface::class)->getMock();
        $collector->method('getId')->willReturn($id);
        $collector->method('getName')->willReturn('Mock Collector');
        $collector->method('isAvailable')->willReturn(true);
        $collector->method('collect')->willReturn([
            'collected_at' => date('Y-m-d H:i:s'),
            'source'       => $id,
            'status'       => 'ok',
            'raw'          => ['test' => true],
            'error'        => null,
        ]);
        return $collector;
    }

    private function makeNotifier(string $id = 'mock_notifier'): NotifierInterface
    {
        $notifier = $this->getMockBuilder(NotifierInterface::class)->getMock();
        $notifier->method('getId')->willReturn($id);
        $notifier->method('isConfigured')->willReturn(false);
        $notifier->method('send')->willReturn(['success' => true, 'message' => 'ok']);
        return $notifier;
    }
}
