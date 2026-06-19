<?php

declare(strict_types=1);

namespace SmartRelay\Tests\Unit\Collectors;

use PHPUnit\Framework\TestCase;
use SmartRelay\Collectors\MeteoYrCollector;

class MeteoYrCollectorTest extends TestCase
{
    private MeteoYrCollector $collector;

    protected function setUp(): void
    {
        $this->collector = new MeteoYrCollector();
    }

    public function testGetIdReturnsMeteoYr(): void
    {
        $this->assertSame('meteo_yr', $this->collector->getId());
    }

    public function testGetNameContainsLocation(): void
    {
        $this->assertStringContainsString('yr.no', $this->collector->getName());
        $this->assertStringContainsString('Weather', $this->collector->getName());
    }

    public function testParseExtractsTemperature(): void
    {
        $raw    = $this->makeFakeApiResponse(temp: 12.5, wind: 3.2, precip: 0.0);
        $parsed = $this->collector->parse($raw);

        $this->assertSame(12.5, $parsed['current']['temperature']);
    }

    public function testParseExtractsWindSpeed(): void
    {
        $raw    = $this->makeFakeApiResponse(temp: 5.0, wind: 8.5, precip: 0.0);
        $parsed = $this->collector->parse($raw);

        $this->assertSame(8.5, $parsed['current']['wind_speed']);
    }

    public function testParseExtractsPrecipitation(): void
    {
        $raw    = $this->makeFakeApiResponse(temp: 2.0, wind: 1.0, precip: 5.2);
        $parsed = $this->collector->parse($raw);

        $this->assertSame(5.2, $parsed['current']['precipitation']);
    }

    public function testParseHandlesEmptyTimeseries(): void
    {
        $raw    = ['properties' => ['timeseries' => []]];
        $parsed = $this->collector->parse($raw);

        $this->assertEmpty($parsed['current']);
    }

    public function testFeelsLikeCoolerInWind(): void
    {
        // Cold temperature + strong wind -> lower feels-like temperature
        $rawCold  = $this->makeFakeApiResponse(temp: -5.0, wind: 10.0, precip: 0.0);
        $rawWarm  = $this->makeFakeApiResponse(temp: -5.0, wind: 0.0, precip: 0.0);

        $parsedCold = $this->collector->parse($rawCold);
        $parsedWarm = $this->collector->parse($rawWarm);

        $this->assertLessThan(
            $parsedWarm['current']['feels_like'],
            $parsedCold['current']['feels_like'],
            'In strong wind, the feels-like temperature should be lower'
        );
    }

    public function testParseDescriptionInEnglish(): void
    {
        $raw    = $this->makeFakeApiResponse(temp: 0.0, wind: 2.0, precip: 3.0, symbol: 'snow_day');
        $parsed = $this->collector->parse($raw);

        $this->assertSame('Snow', $parsed['current']['description']);
    }

    public function testParseForecastDataExists(): void
    {
        $raw    = $this->makeFakeApiResponse(temp: 10.0, wind: 2.0, precip: 0.0);
        $parsed = $this->collector->parse($raw);

        $this->assertArrayHasKey('forecast_6h', $parsed);
        $this->assertArrayHasKey('forecast_12h', $parsed);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private function makeFakeApiResponse(
        float $temp,
        float $wind,
        float $precip,
        string $symbol = 'clearsky_day'
    ): array {
        $entry = [
            'time' => date('Y-m-d\TH:i:s\Z'),
            'data' => [
                'instant' => [
                    'details' => [
                        'air_temperature'          => $temp,
                        'wind_speed'               => $wind,
                        'wind_from_direction'       => 180.0,
                        'relative_humidity'         => 65.0,
                        'air_pressure_at_sea_level' => 1013.0,
                    ],
                ],
                'next_1_hours' => [
                    'summary' => ['symbol_code' => $symbol],
                    'details' => ['precipitation_amount' => $precip],
                ],
            ],
        ];

        // 13 identical entries (so 6h and 12h forecast indices also have data)
        return [
            'properties' => [
                'timeseries' => array_fill(0, 13, $entry),
            ],
        ];
    }
}
