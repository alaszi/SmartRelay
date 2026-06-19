#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * SmartRelay — Daily runner script
 *
 * This is the entry point invoked by cron and GitHub Actions.
 * Wires together: Collector → AlertService → Notifier → Telegram alert
 *
 * Run with: php bin/daily-run.php
 *
 * Location, language, and thresholds are all driven by configuration —
 * this script makes no assumptions about where it's running.
 */

require_once dirname(__DIR__) . '/vendor/autoload.php';

use SmartRelay\Collectors\MeteoYrCollector;
use SmartRelay\Core\Logger;
use SmartRelay\Notifiers\TelegramNotifier;
use SmartRelay\Services\AlertService;
use SmartRelay\Services\MaintenanceService;

$logger = new Logger('daily-run');
$logger->info('=== SmartRelay daily run starting ===');

// ─── Wire up services ─────────────────────────────────────────────────────────

$alertService = new AlertService($logger);
$alertService
    ->registerCollector(new MeteoYrCollector($logger))
    ->registerNotifier(new TelegramNotifier($logger));

// ─── Register alert rules ─────────────────────────────────────────────────────

/**
 * FROST WARNING — temperature drops below 0°C
 */
$alertService->registerRule('frost_warning', function (array $data): ?array {
    $meteo = $data['meteo_yr'] ?? null;
    if (!$meteo || $meteo['status'] !== 'ok') {
        return null;
    }

    $temp      = $meteo['parsed']['current']['temperature'] ?? null;
    $feelsLike = $meteo['parsed']['current']['feels_like'] ?? null;
    $location  = $meteo['location'] ?? 'your area';

    if ($temp === null || $temp >= 0) {
        return null;
    }

    return [
        'subject' => "Frost warning — {$location}",
        'body'    => "❄️ Temperature is {$temp}°C (feels like {$feelsLike}°C).\n\n"
                   . "Suggested precautions:\n"
                   . "• Protect water pipes from freezing\n"
                   . "• Check vehicles for frost protection\n"
                   . "• Protect pets and livestock from the cold",
        'level'   => 'warning',
    ];
});

/**
 * HEAVY SNOW — heavy snow symbol reported
 */
$alertService->registerRule('heavy_snow', function (array $data): ?array {
    $meteo = $data['meteo_yr'] ?? null;
    if (!$meteo || $meteo['status'] !== 'ok') {
        return null;
    }

    $symbol   = $meteo['parsed']['current']['symbol'] ?? '';
    $temp     = $meteo['parsed']['current']['temperature'] ?? 20;
    $location = $meteo['location'] ?? 'your area';

    if (!str_contains($symbol, 'heavysnow') && !str_contains($symbol, 'snowandthunder')) {
        return null;
    }

    return [
        'subject' => "Heavy snow — {$location}",
        'body'    => "🌨️ Heavy snow expected, temperature: {$temp}°C.\n\n"
                   . "Suggested precautions:\n"
                   . "• Check road maintenance status\n"
                   . "• Check roofs for snow load\n"
                   . "• Monitor road conditions",
        'level'   => 'warning',
    ];
});

/**
 * HIGH WIND — above 15 m/s (54 km/h)
 */
$alertService->registerRule('high_wind', function (array $data): ?array {
    $meteo = $data['meteo_yr'] ?? null;
    if (!$meteo || $meteo['status'] !== 'ok') {
        return null;
    }

    $wind     = $meteo['parsed']['current']['wind_speed'] ?? 0;
    $location = $meteo['location'] ?? 'your area';

    if ($wind < 15) {
        return null;
    }

    $kmh = round($wind * 3.6);
    return [
        'subject' => "High wind — {$location}",
        'body'    => "💨 Wind speed: {$wind} m/s ({$kmh} km/h).\n\n"
                   . "Suggested precautions:\n"
                   . "• Avoid open areas\n"
                   . "• Secure loose objects outdoors\n"
                   . "• Pause forestry/outdoor work",
        'level'   => 'warning',
    ];
});

/**
 * DAILY SUMMARY — always sends a short weather briefing
 */
$alertService->registerRule('daily_summary', function (array $data): ?array {
    $meteo = $data['meteo_yr'] ?? null;
    if (!$meteo || $meteo['status'] !== 'ok') {
        return null;
    }

    $c        = $meteo['parsed']['current'];
    $f6       = $meteo['parsed']['forecast_6h'];
    $f12      = $meteo['parsed']['forecast_12h'];
    $location = $meteo['location'] ?? 'your area';
    $date     = date('F j, Y', strtotime($meteo['collected_at']));

    $body = "📍 *{$location}* — {$date}\n\n"
          . "*Current conditions:*\n"
          . "🌡️ Temperature: {$c['temperature']}°C (feels like {$c['feels_like']}°C)\n"
          . "💧 Humidity: {$c['humidity']}%\n"
          . "💨 Wind: {$c['wind_speed']} m/s\n"
          . "🌧️ Precipitation: {$c['precipitation']} mm/h\n"
          . "☁️ {$c['description']}\n\n";

    if (!empty($f6['temperature'])) {
        $body .= "*In 6 hours:* {$f6['temperature']}°C — {$f6['description']}\n";
    }
    if (!empty($f12['temperature'])) {
        $body .= "*In 12 hours:* {$f12['temperature']}°C — {$f12['description']}\n";
    }

    return [
        'subject' => "Daily weather briefing — {$location}",
        'body'    => $body,
        'level'   => 'info',
    ];
});

// ─── Run ───────────────────────────────────────────────────────────────────────

$results = [];

// Alert service
if ($alertService->isReady()) {
    $results['alert'] = $alertService->execute();
} else {
    $logger->warning('Alert service not ready — check configuration');
}

// Maintenance reminders
$maintenanceService = new MaintenanceService($logger);
$maintenanceService->registerNotifier(new TelegramNotifier($logger));
if ($maintenanceService->isReady()) {
    $results['maintenance'] = $maintenanceService->execute();
}

// Summary log
$logger->info('=== Daily run complete ===', [
    'alerts' => $results['alert']['alerts'] ?? 0,
    'sent'   => $results['alert']['sent'] ?? 0,
]);

echo json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . PHP_EOL;
exit(0);
