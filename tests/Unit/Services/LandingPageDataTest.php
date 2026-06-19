<?php

declare(strict_types=1);

namespace SmartRelay\Tests\Unit\Services;

use PHPUnit\Framework\TestCase;
use SmartRelay\Collectors\MeteoYrCollector;
use SmartRelay\Services\LandingPageData;

class LandingPageDataTest extends TestCase
{
    public function testReturnsEmptySnapshotWhenCollectorUnavailable(): void
    {
        $collector = $this->createMock(MeteoYrCollector::class);
        $collector->method('isAvailable')->willReturn(false);

        $data     = new LandingPageData($collector);
        $snapshot = $data->getWeatherSnapshot();

        $this->assertFalse($snapshot['available']);
        $this->assertSame('—', $snapshot['temperature']);
        $this->assertSame('Élő adat hamarosan', $snapshot['description']);
    }

    public function testReturnsEmptySnapshotWhenStatusIsError(): void
    {
        $collector = $this->createMock(MeteoYrCollector::class);
        $collector->method('isAvailable')->willReturn(true);
        $collector->method('collect')->willReturn([
            'status' => 'error',
            'error'  => 'API hiba',
        ]);

        $data     = new LandingPageData($collector);
        $snapshot = $data->getWeatherSnapshot();

        $this->assertFalse($snapshot['available']);
    }

    public function testReturnsEmptySnapshotWhenCollectorThrows(): void
    {
        $collector = $this->createMock(MeteoYrCollector::class);
        $collector->method('isAvailable')->willReturn(true);
        $collector->method('collect')->willThrowException(new \RuntimeException('boom'));

        $data     = new LandingPageData($collector);
        $snapshot = $data->getWeatherSnapshot();

        $this->assertFalse($snapshot['available']);
    }

    public function testReturnsRealDataWhenCollectorSucceeds(): void
    {
        $collector = $this->createMock(MeteoYrCollector::class);
        $collector->method('isAvailable')->willReturn(true);
        $collector->method('collect')->willReturn([
            'status'       => 'ok',
            'location'     => 'Gyergyócsomafalva',
            'collected_at' => '2026-06-19 06:30:00',
            'parsed'       => [
                'current' => [
                    'temperature'   => 8.5,
                    'wind_speed'    => 2.1,
                    'humidity'      => 70,
                    'precipitation' => 0.0,
                    'description'   => 'Derült',
                ],
            ],
        ]);

        $data     = new LandingPageData($collector);
        $snapshot = $data->getWeatherSnapshot();

        $this->assertTrue($snapshot['available']);
        $this->assertSame('8.5°C', $snapshot['temperature']);
        $this->assertSame('2.1 m/s', $snapshot['wind']);
        $this->assertSame('Derült', $snapshot['description']);
        $this->assertSame('06:30', $snapshot['updated_at']);
    }

    public function testGetChannelUrlReturnsTelegramLink(): void
    {
        $data = new LandingPageData($this->createMock(MeteoYrCollector::class));
        $this->assertSame('https://t.me/SmartRelay', $data->getChannelUrl());
    }
}
