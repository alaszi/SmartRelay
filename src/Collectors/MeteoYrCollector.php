<?php

declare(strict_types=1);

namespace SmartRelay\Collectors;

use SmartRelay\Core\Config;
use SmartRelay\Core\Logger;

/**
 * Weather data collector — yr.no / api.met.no
 *
 * Free, registration-free Norwegian meteorological API.
 * Docs: https://api.met.no/weatherapi/locationforecast/2.0/
 *
 * Works for any location worldwide — fully driven by configuration.
 * Default location is provided only as a convenience fallback when
 * no configuration is set; it carries no special meaning in the code.
 * Configure via: METEO_LAT, METEO_LON, METEO_ALTITUDE, METEO_LOCATION_NAME
 */
class MeteoYrCollector implements CollectorInterface
{
    private const API_URL   = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
    private const TIMEOUT   = 15;
    private const CACHE_TTL = 1800; // 30 minutes — required by yr.no's terms of use

    // Convenience default — overridden entirely by config in any real deployment
    private const DEFAULT_LAT      = 46.783;
    private const DEFAULT_LON      = 25.633;
    private const DEFAULT_ALTITUDE = 860;
    private const DEFAULT_NAME     = 'Default Location';

    private Logger $logger;

    public function __construct(?Logger $logger = null)
    {
        $this->logger = $logger ?? new Logger('meteo-yr');
    }

    public function getId(): string
    {
        return 'meteo_yr';
    }

    public function getName(): string
    {
        return 'Weather — yr.no (' . $this->getLocationName() . ')';
    }

    public function isAvailable(): bool
    {
        // Cache check — if fresh (< 30 min), skip calling the API again
        $cache = $this->getCachePath();
        if (file_exists($cache) && (time() - filemtime($cache)) < self::CACHE_TTL) {
            $this->logger->debug('Cache hit, skipping API call');
            return true;
        }

        // Simple connectivity check
        $ch = curl_init(self::API_URL . '?lat=' . $this->getLat() . '&lon=' . $this->getLon());
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_NOBODY         => true,
            CURLOPT_HTTPHEADER     => [$this->userAgent()],
        ]);
        curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return $code === 200;
    }

    public function collect(): array
    {
        $this->logger->info('Starting weather collection', [
            'location' => $this->getLocationName(),
            'lat'      => $this->getLat(),
            'lon'      => $this->getLon(),
        ]);

        // Serve from cache if fresh
        $cached = $this->fromCache();
        if ($cached !== null) {
            $this->logger->debug('Returned from cache');
            return $cached;
        }

        $raw = $this->fetchFromApi();

        if ($raw === null) {
            return [
                'collected_at' => date('Y-m-d H:i:s'),
                'source'       => $this->getId(),
                'status'       => 'error',
                'error'        => 'API request failed',
                'raw'          => null,
                'parsed'       => null,
            ];
        }

        $parsed = $this->parse($raw);
        $result = [
            'collected_at' => date('Y-m-d H:i:s'),
            'source'       => $this->getId(),
            'location'     => $this->getLocationName(),
            'status'       => 'ok',
            'error'        => null,
            'raw'          => $raw,
            'parsed'       => $parsed,
        ];

        $this->toCache($result);

        $this->logger->info('Weather data collected', [
            'temperature' => $parsed['current']['temperature'] . '°C',
            'wind'        => $parsed['current']['wind_speed'] . ' m/s',
        ]);

        return $result;
    }

    /**
     * Parse raw API data — extract only the fields we actually use.
     */
    public function parse(array $raw): array
    {
        $timeseries = $raw['properties']['timeseries'] ?? [];

        if (empty($timeseries)) {
            return ['current' => [], 'forecast_6h' => [], 'forecast_12h' => []];
        }

        // Current conditions (first timestamp)
        $current = $timeseries[0]['data']['instant']['details'] ?? [];
        $next1h  = $timeseries[0]['data']['next_1_hours']['details'] ?? [];
        $symbol  = $timeseries[0]['data']['next_1_hours']['summary']['symbol_code'] ?? 'unknown';

        // Roughly 6h and 12h ahead (approximate indices)
        $idx6h  = min(6, count($timeseries) - 1);
        $idx12h = min(12, count($timeseries) - 1);

        return [
            'current' => [
                'temperature'    => round((float)($current['air_temperature'] ?? 0), 1),
                'feels_like'     => $this->feelsLike(
                    (float)($current['air_temperature'] ?? 0),
                    (float)($current['wind_speed'] ?? 0)
                ),
                'wind_speed'     => round((float)($current['wind_speed'] ?? 0), 1),
                'wind_direction' => round((float)($current['wind_from_direction'] ?? 0)),
                'humidity'       => round((float)($current['relative_humidity'] ?? 0)),
                'pressure'       => round((float)($current['air_pressure_at_sea_level'] ?? 0)),
                'precipitation'  => round((float)($next1h['precipitation_amount'] ?? 0), 1),
                'symbol'         => $symbol,
                'description'    => $this->symbolToText($symbol),
            ],
            'forecast_6h'  => $this->extractForecast($timeseries[$idx6h] ?? []),
            'forecast_12h' => $this->extractForecast($timeseries[$idx12h] ?? []),
            'updated_at'   => $timeseries[0]['time'] ?? '',
        ];
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private function fetchFromApi(): ?array
    {
        $url = sprintf(
            '%s?lat=%s&lon=%s&altitude=%d',
            self::API_URL,
            $this->getLat(),
            $this->getLon(),
            $this->getAltitude()
        );

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => self::TIMEOUT,
            CURLOPT_HTTPHEADER     => [
                $this->userAgent(),
                'Accept: application/json',
            ],
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error    = curl_error($ch);
        curl_close($ch);

        if ($error) {
            $this->logger->error('cURL error', ['error' => $error]);
            return null;
        }

        if ($httpCode !== 200) {
            $this->logger->error('API error', ['http_code' => $httpCode]);
            return null;
        }

        $data = json_decode($response, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            $this->logger->error('JSON parse error', ['error' => json_last_error_msg()]);
            return null;
        }

        return $data;
    }

    private function extractForecast(array $entry): array
    {
        $details = $entry['data']['instant']['details'] ?? [];
        $symbol  = $entry['data']['next_6_hours']['summary']['symbol_code']
                ?? $entry['data']['next_1_hours']['summary']['symbol_code']
                ?? 'unknown';

        return [
            'time'        => $entry['time'] ?? '',
            'temperature' => round((float)($details['air_temperature'] ?? 0), 1),
            'wind_speed'  => round((float)($details['wind_speed'] ?? 0), 1),
            'symbol'      => $symbol,
            'description' => $this->symbolToText($symbol),
        ];
    }

    /** Wind chill calculation */
    private function feelsLike(float $temp, float $windMs): float
    {
        if ($temp > 10 || $windMs < 1.3) {
            return round($temp, 1);
        }
        $kmh = $windMs * 3.6;
        $wc  = 13.12 + 0.6215 * $temp - 11.37 * pow($kmh, 0.16) + 0.3965 * $temp * pow($kmh, 0.16);
        return round($wc, 1);
    }

    private function symbolToText(string $symbol): string
    {
        $map = [
            'clearsky'         => 'Clear sky',
            'fair'              => 'Mostly clear',
            'partlycloudy'      => 'Partly cloudy',
            'cloudy'            => 'Cloudy',
            'fog'               => 'Fog',
            'lightrain'         => 'Light rain',
            'rain'              => 'Rain',
            'heavyrain'         => 'Heavy rain',
            'lightsleet'        => 'Light sleet',
            'sleet'             => 'Sleet',
            'heavysleet'        => 'Heavy sleet',
            'lightsnow'         => 'Light snow',
            'snow'              => 'Snow',
            'heavysnow'         => 'Heavy snow',
            'lightrainshowers'  => 'Light rain showers',
            'rainshowers'       => 'Rain showers',
            'heavyrainshowers'  => 'Heavy rain showers',
            'lightsnowshowers'  => 'Light snow showers',
            'snowshowers'       => 'Snow showers',
            'thunder'           => 'Thunderstorm',
            'rainandthunder'    => 'Rain and thunder',
            'snowandthunder'    => 'Snow and thunder',
        ];

        // Strip the day/night/polar-twilight suffix (_day, _night, _polartwilight)
        $base = preg_replace('/_(?:day|night|polartwilight)$/', '', $symbol);
        return $map[$base] ?? ucfirst(str_replace('_', ' ', $base));
    }

    private function userAgent(): string
    {
        return 'User-Agent: SmartRelay/1.0 smartrelay.ro contact@smartrelay.ro';
    }

    private function getCachePath(): string
    {
        $dir = dirname(__DIR__, 2) . '/logs';
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }
        return $dir . '/meteo_cache.json';
    }

    private function fromCache(): ?array
    {
        $path = $this->getCachePath();
        if (!file_exists($path)) {
            return null;
        }
        if ((time() - filemtime($path)) >= self::CACHE_TTL) {
            return null;
        }
        $data = json_decode(file_get_contents($path), true);
        return is_array($data) ? $data : null;
    }

    private function toCache(array $data): void
    {
        file_put_contents($this->getCachePath(), json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    }

    private function getLat(): float
    {
        return (float)(Config::get('METEO_LAT', self::DEFAULT_LAT));
    }

    private function getLon(): float
    {
        return (float)(Config::get('METEO_LON', self::DEFAULT_LON));
    }

    private function getAltitude(): int
    {
        return (int)(Config::get('METEO_ALTITUDE', self::DEFAULT_ALTITUDE));
    }

    private function getLocationName(): string
    {
        return Config::get('METEO_LOCATION_NAME', self::DEFAULT_NAME);
    }
}
