<?php

declare(strict_types=1);

namespace SmartRelay\Services;

use SmartRelay\Collectors\CollectorInterface;
use SmartRelay\Core\Logger;
use SmartRelay\Core\ServiceInterface;
use SmartRelay\Notifiers\NotifierInterface;

/**
 * Regional Alert Service — SmartRelay's public-facing function.
 *
 * Orchestrates the alert pipeline:
 *   1. Run all registered collectors
 *   2. Evaluate collected data against alert rules
 *   3. Send notifications via all registered notifiers
 *   4. Return a run report
 *
 * Adding a new data source = register a new CollectorInterface.
 * Adding a new alert channel = register a new NotifierInterface.
 * The service itself never needs to change.
 */
class AlertService implements ServiceInterface
{
    /** @var CollectorInterface[] */
    private array $collectors = [];

    /** @var NotifierInterface[] */
    private array $notifiers = [];

    /** @var array<string, callable> Alert rules: rule_id => fn(array $data): ?array */
    private array $rules = [];

    private Logger $logger;

    public function __construct(?Logger $logger = null)
    {
        $this->logger = $logger ?? new Logger('alert-service');
    }

    public function getName(): string
    {
        return 'Regional Alert Service';
    }

    public function isReady(): bool
    {
        if (empty($this->collectors)) {
            $this->logger->warning('No collectors registered');
            return false;
        }
        if (empty($this->notifiers)) {
            $this->logger->warning('No notifiers registered');
            return false;
        }
        return true;
    }

    public function registerCollector(CollectorInterface $collector): self
    {
        $this->collectors[$collector->getId()] = $collector;
        $this->logger->debug('Collector registered', ['id' => $collector->getId()]);
        return $this;
    }

    public function registerNotifier(NotifierInterface $notifier): self
    {
        $this->notifiers[$notifier->getId()] = $notifier;
        $this->logger->debug('Notifier registered', ['id' => $notifier->getId()]);
        return $this;
    }

    /**
     * Register an alert rule.
     *
     * @param string   $id       Unique rule identifier
     * @param callable $rule     fn(array $collectedData): ?array
     *                           Returns null if no alert, or:
     *                           ['subject' => '...', 'body' => '...', 'level' => 'warning']
     */
    public function registerRule(string $id, callable $rule): self
    {
        $this->rules[$id] = $rule;
        return $this;
    }

    public function execute(): array
    {
        $this->logger->info('Alert service run started');

        $collected = $this->runCollectors();
        $alerts    = $this->evaluateRules($collected);
        $sent      = $this->sendAlerts($alerts);

        $report = [
            'success'    => true,
            'message'    => 'Alert service completed',
            'collectors' => count($this->collectors),
            'alerts'     => count($alerts),
            'sent'       => $sent,
            'data'       => $collected,
        ];

        $this->logger->info('Alert service run completed', $report);
        return $report;
    }

    private function runCollectors(): array
    {
        $results = [];
        foreach ($this->collectors as $id => $collector) {
            if (!$collector->isAvailable()) {
                $this->logger->warning('Collector unavailable', ['id' => $id]);
                $results[$id] = ['status' => 'unavailable', 'raw' => null];
                continue;
            }
            try {
                $results[$id] = $collector->collect();
                $this->logger->debug('Collected', ['id' => $id, 'status' => $results[$id]['status']]);
            } catch (\Throwable $e) {
                $this->logger->error('Collector failed', ['id' => $id, 'error' => $e->getMessage()]);
                $results[$id] = ['status' => 'error', 'error' => $e->getMessage(), 'raw' => null];
            }
        }
        return $results;
    }

    private function evaluateRules(array $data): array
    {
        $alerts = [];
        foreach ($this->rules as $ruleId => $rule) {
            try {
                $alert = $rule($data);
                if ($alert !== null) {
                    $alert['rule_id'] = $ruleId;
                    $alerts[]         = $alert;
                    $this->logger->info('Alert triggered', ['rule' => $ruleId, 'level' => $alert['level'] ?? 'info']);
                }
            } catch (\Throwable $e) {
                $this->logger->error('Rule evaluation failed', ['rule' => $ruleId, 'error' => $e->getMessage()]);
            }
        }
        return $alerts;
    }

    private function sendAlerts(array $alerts): int
    {
        $sent = 0;
        foreach ($alerts as $alert) {
            foreach ($this->notifiers as $notifier) {
                if (!$notifier->isConfigured()) {
                    continue;
                }
                $result = $notifier->send(
                    $alert['subject'] ?? 'SmartRelay Alert',
                    $alert['body'] ?? '',
                    $alert['level'] ?? 'info',
                );
                if ($result['success']) {
                    $sent++;
                }
            }
        }
        return $sent;
    }
}
