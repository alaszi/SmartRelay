<?php

declare(strict_types=1);

namespace SmartRelay\Core;

/**
 * Lightweight structured logger.
 *
 * Writes to a log file and optionally to stdout (CI/cron environments).
 * Format: [YYYY-MM-DD HH:MM:SS] [LEVEL] [context] message {json_data}
 *
 * Deliberately simple — can be swapped for Monolog later without changing callers.
 */
class Logger
{
    public const DEBUG   = 'DEBUG';
    public const INFO    = 'INFO';
    public const WARNING = 'WARNING';
    public const ERROR   = 'ERROR';

    private string $context;
    private string $logFile;
    private bool $stdout;

    public function __construct(string $context = 'app', ?string $logFile = null)
    {
        $this->context = $context;
        $this->logFile = $logFile ?? (dirname(__DIR__, 2) . '/logs/smartrelay.log');
        $this->stdout  = PHP_SAPI === 'cli';

        $dir = dirname($this->logFile);
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }
    }

    public function debug(string $message, array $data = []): void
    {
        $this->write(self::DEBUG, $message, $data);
    }

    public function info(string $message, array $data = []): void
    {
        $this->write(self::INFO, $message, $data);
    }

    public function warning(string $message, array $data = []): void
    {
        $this->write(self::WARNING, $message, $data);
    }

    public function error(string $message, array $data = []): void
    {
        $this->write(self::ERROR, $message, $data);
    }

    private function write(string $level, string $message, array $data): void
    {
        $timestamp = date('Y-m-d H:i:s');
        $dataStr   = empty($data) ? '' : ' ' . json_encode($data, JSON_UNESCAPED_UNICODE);
        $line      = "[{$timestamp}] [{$level}] [{$this->context}] {$message}{$dataStr}" . PHP_EOL;

        file_put_contents($this->logFile, $line, FILE_APPEND | LOCK_EX);

        if ($this->stdout) {
            echo $line;
        }
    }
}
