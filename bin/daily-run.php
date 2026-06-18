#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * SmartRelay — Napi futtatószript
 *
 * Ez a belépési pont amit a cron és a GitHub Actions hív.
 * Összekötí: Collector → AlertService → Notifier → Telegram riasztás
 *
 * Futtatás: php bin/daily-run.php
 */

require_once dirname(__DIR__) . '/vendor/autoload.php';

use SmartRelay\Collectors\MeteoYrCollector;
use SmartRelay\Core\Logger;
use SmartRelay\Notifiers\TelegramNotifier;
use SmartRelay\Services\AlertService;
use SmartRelay\Services\MaintenanceService;

$logger = new Logger('daily-run');
$logger->info('=== SmartRelay napi futtatás indítása ===');

// ─── Szolgáltatások összerakása ───────────────────────────────────────────────

$alertService = new AlertService($logger);
$alertService
    ->registerCollector(new MeteoYrCollector($logger))
    ->registerNotifier(new TelegramNotifier($logger));

// ─── Alert szabályok regisztrálása ───────────────────────────────────────────

/**
 * FAGYÁSVESZÉLY — ha a hőmérséklet 0°C alá esik
 */
$alertService->registerRule('fagyasveszely', function (array $data): ?array {
    $meteo = $data['meteo_yr'] ?? null;
    if (!$meteo || $meteo['status'] !== 'ok') {
        return null;
    }

    $temp      = $meteo['parsed']['current']['temperature'] ?? null;
    $feelsLike = $meteo['parsed']['current']['feels_like'] ?? null;
    $location  = $meteo['location'] ?? 'Gyergyó';

    if ($temp === null || $temp >= 0) {
        return null;
    }

    return [
        'subject' => "Fagyásveszély — {$location}",
        'body'    => "❄️ A hőmérséklet {$temp}°C (érzett: {$feelsLike}°C).\n\n"
                   . "Javasolt intézkedések:\n"
                   . "• Vízvezetékek védelme\n"
                   . "• Gépjárművek fagyvédő ellenőrzése\n"
                   . "• Háziállatok védelme",
        'level'   => 'warning',
    ];
});

/**
 * HEVES HAVAZÁS — erős havazás szimbólum esetén
 */
$alertService->registerRule('heves_havazas', function (array $data): ?array {
    $meteo = $data['meteo_yr'] ?? null;
    if (!$meteo || $meteo['status'] !== 'ok') {
        return null;
    }

    $symbol   = $meteo['parsed']['current']['symbol'] ?? '';
    $temp     = $meteo['parsed']['current']['temperature'] ?? 20;
    $location = $meteo['location'] ?? 'Gyergyó';

    if (!str_contains($symbol, 'heavysnow') && !str_contains($symbol, 'snowandthunder')) {
        return null;
    }

    return [
        'subject' => "Erős havazás — {$location}",
        'body'    => "🌨️ Erős havazás várható, hőmérséklet: {$temp}°C.\n\n"
                   . "Javasolt intézkedések:\n"
                   . "• Útfenntartás ellenőrzése\n"
                   . "• Tetők terhelhetőségének ellenőrzése\n"
                   . "• Útviszonyok követése",
        'level'   => 'warning',
    ];
});

/**
 * ERŐS SZÉL — 15 m/s felett (54 km/h)
 */
$alertService->registerRule('eros_szel', function (array $data): ?array {
    $meteo = $data['meteo_yr'] ?? null;
    if (!$meteo || $meteo['status'] !== 'ok') {
        return null;
    }

    $wind     = $meteo['parsed']['current']['wind_speed'] ?? 0;
    $location = $meteo['location'] ?? 'Gyergyó';

    if ($wind < 15) {
        return null;
    }

    $kmh = round($wind * 3.6);
    return [
        'subject' => "Erős szél — {$location}",
        'body'    => "💨 Szélsebesség: {$wind} m/s ({$kmh} km/h).\n\n"
                   . "Javasolt intézkedések:\n"
                   . "• Szabad területen tartózkodás kerülendő\n"
                   . "• Rögzítetlen tárgyak biztosítása\n"
                   . "• Erdei munkák szüneteltetése",
        'level'   => 'warning',
    ];
});

/**
 * NAPI ÖSSZEFOGLALÓ — mindig küld egy rövid időjárás-jelentést
 */
$alertService->registerRule('napi_osszefoglalo', function (array $data): ?array {
    $meteo = $data['meteo_yr'] ?? null;
    if (!$meteo || $meteo['status'] !== 'ok') {
        return null;
    }

    $c        = $meteo['parsed']['current'];
    $f6       = $meteo['parsed']['forecast_6h'];
    $f12      = $meteo['parsed']['forecast_12h'];
    $location = $meteo['location'] ?? 'Gyergyó';
    $date     = date('Y. F j.', strtotime($meteo['collected_at']));

    $body = "📍 *{$location}* — {$date}\n\n"
          . "*Jelenlegi időjárás:*\n"
          . "🌡️ Hőmérséklet: {$c['temperature']}°C (érzett: {$c['feels_like']}°C)\n"
          . "💧 Páratartalom: {$c['humidity']}%\n"
          . "💨 Szél: {$c['wind_speed']} m/s\n"
          . "🌧️ Csapadék: {$c['precipitation']} mm/h\n"
          . "☁️ {$c['description']}\n\n";

    if (!empty($f6['temperature'])) {
        $body .= "*6 óra múlva:* {$f6['temperature']}°C — {$f6['description']}\n";
    }
    if (!empty($f12['temperature'])) {
        $body .= "*12 óra múlva:* {$f12['temperature']}°C — {$f12['description']}\n";
    }

    return [
        'subject' => "Napi időjárás — {$location}",
        'body'    => $body,
        'level'   => 'info',
    ];
});

// ─── Futtatás ────────────────────────────────────────────────────────────────

$results = [];

// Alert service
if ($alertService->isReady()) {
    $results['alert'] = $alertService->execute();
} else {
    $logger->warning('Alert service nem áll készen — ellenőrizd a konfigurációt');
}

// Karbantartási emlékeztetők
$maintenanceService = new MaintenanceService($logger);
$maintenanceService->registerNotifier(new TelegramNotifier($logger));
if ($maintenanceService->isReady()) {
    $results['maintenance'] = $maintenanceService->execute();
}

// Összefoglaló log
$logger->info('=== Napi futtatás befejezve ===', [
    'riasztások' => $results['alert']['alerts'] ?? 0,
    'küldések'   => $results['alert']['sent'] ?? 0,
]);

echo json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . PHP_EOL;
exit(0);
