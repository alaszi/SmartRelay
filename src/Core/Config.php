<?php

declare(strict_types=1);

namespace SmartRelay\Core;

/**
 * Configuration loader.
 *
 * Reads from environment variables (production) or a local .env file (dev).
 * Never hardcodes secrets. All callers use Config::get() — the source can
 * change later without touching service code.
 */
class Config
{
    private static array $cache = [];
    private static bool $loaded = false;

    /**
     * Get a config value by key, with optional default.
     */
    public static function get(string $key, mixed $default = null): mixed
    {
        if (!self::$loaded) {
            self::load();
        }

        return self::$cache[$key] ?? getenv($key) ?: $default;
    }

    /**
     * Check if a config key is set and non-empty.
     */
    public static function has(string $key): bool
    {
        return self::get($key) !== null && self::get($key) !== '';
    }

    /**
     * Load .env file if it exists (local development only).
     * Production relies on real environment variables.
     */
    private static function load(): void
    {
        self::$loaded = true;

        $envFile = dirname(__DIR__, 2) . '/.env';
        if (!file_exists($envFile)) {
            return;
        }

        $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        foreach ($lines as $line) {
            $line = trim($line);
            if (str_starts_with($line, '#') || !str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = explode('=', $line, 2);
            $key   = trim($key);
            $value = trim($value, " \t\n\r\0\x0B\"'");

            self::$cache[$key] = $value;
        }
    }

    /**
     * Reset cache — used in unit tests only.
     */
    public static function reset(): void
    {
        self::$cache  = [];
        self::$loaded = false;
    }
}
