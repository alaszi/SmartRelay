<?php

declare(strict_types=1);

namespace SmartRelay\Services;

use SmartRelay\Collectors\MeteoYrCollector;

/**
 * Adatszolgáltató a publikus landing page-hez.
 *
 * Elválasztja az adat-logikát a HTML rendertéstől, hogy tesztelhető
 * legyen a CLAUDE.md szabályai szerint. A public/index.php csak ezt
 * hívja meg, sosem fér hozzá direktben a Collector-hoz.
 */
class LandingPageData
{
    private MeteoYrCollector $collector;

    public function __construct(?MeteoYrCollector $collector = null)
    {
        $this->collector = $collector ?? new MeteoYrCollector();
    }

    /**
     * Élő időjárás pillanatkép a hero panelhez.
     * Sosem dob hibát — ha az adat nem elérhető, "üres állapot" jellegű
     * választ ad, nem hibaüzenetet.
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
            'location'      => $result['location'] ?? 'Gyergyócsomafalva',
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
            'description'   => 'Élő adat hamarosan',
            'location'      => 'Gyergyócsomafalva',
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
