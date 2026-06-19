<?php

declare(strict_types=1);

namespace SmartRelay\Services;

use SmartRelay\Collectors\MeteoYrCollector;

/**
 * Data provider for the public landing page.
 *
 * Separates data logic from HTML rendering so it stays testable per
 * CLAUDE.md rules. public/index.php only calls this — it never
 * touches the Collector directly.
 */
class LandingPageData
{
    private MeteoYrCollector $collector;

    public function __construct(?MeteoYrCollector $collector = null)
    {
        $this->collector = $collector ?? new MeteoYrCollector();
    }

    /**
     * Live weather snapshot for the hero panel.
     * Never throws — if data isn't available, returns an "empty state"
     * response rather than an error message.
     */
    public function getWeatherSnapshot(): array
    {
        if (!$this->collector->isAvailable()) {
            return $this->emptySnapshot();
        }

        try {
            $result = $this->collector->collect();
        } catch (\Throwable $e) {
            return $this->emptySnapshot();
        }

        $current = $result['parsed']['current'] ?? null;

        if (($result['status'] ?? '') !== 'ok' || empty($current)) {
            return $this->emptySnapshot();
        }

        return [
            'available'     => true,
            'temperature'   => $current['temperature'] . '°C',
            'wind'          => $current['wind_speed'] . ' m/s',
            'humidity'      => $current['humidity'] . '%',
            'precipitation' => $current['precipitation'] . ' mm/h',
            'description'   => $current['description'],
            'location'      => $result['location'] ?? 'Default Location',
            'updated_at'    => $this->formatTimestamp($result['collected_at'] ?? ''),
        ];
    }

    public function getChannelUrl(): string
    {
        return 'https://t.me/SmartRelay';
    }

    private function emptySnapshot(): array
    {
        return [
            'available'     => false,
            'temperature'   => '—',
            'wind'          => '—',
            'humidity'      => '—',
            'precipitation' => '—',
            'description'   => 'Live data coming soon',
            'location'      => 'Default Location',
            'updated_at'    => '',
        ];
    }

    private function formatTimestamp(string $raw): string
    {
        if ($raw === '') {
            return '';
        }
        $time = strtotime($raw);
        return $time === false ? '' : date('H:i', $time);
    }
}
