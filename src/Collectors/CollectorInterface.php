<?php

declare(strict_types=1);

namespace SmartRelay\Collectors;

/**
 * Contract for all data collectors (weather, power, road conditions, sensors).
 *
 * A collector's only job: fetch raw data from one external source.
 * It does NOT process, format, or send anything — that's the processor's job.
 * This separation means a broken external source only breaks its own collector,
 * not the whole system.
 */
interface CollectorInterface
{
    /**
     * Unique machine-readable identifier for this collector.
     * Example: 'meteo_harghita', 'electrica_outages', 'sensor_temp_01'
     */
    public function getId(): string;

    /**
     * Human-readable name for logs and reports.
     */
    public function getName(): string;

    /**
     * Returns true if the data source is reachable and the collector is configured.
     */
    public function isAvailable(): bool;

    /**
     * Fetch raw data from the source.
     *
     * Returns a normalized array:
     * [
     *   'collected_at' => '2026-06-18 22:00:00',
     *   'source'       => 'meteo_harghita',
     *   'raw'          => [...],   // original data, unchanged
     *   'status'       => 'ok' | 'error' | 'partial',
     *   'error'        => null | 'Error description',
     * ]
     */
    public function collect(): array;
}
