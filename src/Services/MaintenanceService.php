<?php

declare(strict_types=1);

namespace SmartRelay\Services;

use SmartRelay\Core\Logger;
use SmartRelay\Core\ServiceInterface;
use SmartRelay\Notifiers\NotifierInterface;

/**
 * CMMS-lite Maintenance Service — SmartRelay's B2B function.
 *
 * Manages equipment maintenance schedules for small operations.
 * Sends reminders when tasks are due and flags anomalies.
 *
 * Data is stored in a simple JSON file or MySQL table (configurable).
 * No UI yet — equipment records are added via config/equipment.php.
 * A web UI or API endpoint can be layered on top later.
 */
class MaintenanceService implements ServiceInterface
{
    /** @var NotifierInterface[] */
    private array $notifiers = [];

    private Logger $logger;
    private string $dataPath;

    public function __construct(?Logger $logger = null, ?string $dataPath = null)
    {
        $this->logger   = $logger ?? new Logger('maintenance');
        $this->dataPath = $dataPath ?? dirname(__DIR__, 2) . '/config/equipment.json';
    }

    public function getName(): string
    {
        return 'CMMS-lite Maintenance Service';
    }

    public function isReady(): bool
    {
        if (!file_exists($this->dataPath)) {
            $this->logger->warning('Equipment data file not found', ['path' => $this->dataPath]);
            return false;
        }
        return true;
    }

    public function registerNotifier(NotifierInterface $notifier): self
    {
        $this->notifiers[$notifier->getId()] = $notifier;
        return $this;
    }

    public function execute(): array
    {
        $this->logger->info('Maintenance service run started');

        $equipment = $this->loadEquipment();
        $due       = $this->findDueTasks($equipment);
        $overdue   = $this->findOverdueTasks($equipment);
        $sent      = $this->sendReminders($due, $overdue);

        $report = [
            'success'   => true,
            'message'   => 'Maintenance service completed',
            'equipment' => count($equipment),
            'due'       => count($due),
            'overdue'   => count($overdue),
            'sent'      => $sent,
        ];

        $this->logger->info('Maintenance service completed', $report);
        return $report;
    }

    private function loadEquipment(): array
    {
        $raw = file_get_contents($this->dataPath);
        return json_decode($raw, true) ?? [];
    }

    private function findDueTasks(array $equipment): array
    {
        $due  = [];
        $today = new \DateTime();

        foreach ($equipment as $item) {
            foreach ($item['tasks'] ?? [] as $task) {
                $dueDate = new \DateTime($task['next_due']);
                $diff    = (int) $today->diff($dueDate)->format('%r%a');

                // Due within next 7 days
                if ($diff >= 0 && $diff <= 7) {
                    $due[] = array_merge($task, [
                        'equipment_name' => $item['name'],
                        'days_until_due' => $diff,
                    ]);
                }
            }
        }

        return $due;
    }

    private function findOverdueTasks(array $equipment): array
    {
        $overdue = [];
        $today   = new \DateTime();

        foreach ($equipment as $item) {
            foreach ($item['tasks'] ?? [] as $task) {
                $dueDate = new \DateTime($task['next_due']);
                $diff    = (int) $today->diff($dueDate)->format('%r%a');

                if ($diff < 0) {
                    $overdue[] = array_merge($task, [
                        'equipment_name' => $item['name'],
                        'days_overdue'   => abs($diff),
                    ]);
                }
            }
        }

        return $overdue;
    }

    private function sendReminders(array $due, array $overdue): int
    {
        $sent = 0;

        if (!empty($overdue)) {
            $body = "The following maintenance tasks are overdue:\n\n";
            foreach ($overdue as $task) {
                $body .= "• *{$task['equipment_name']}* — {$task['name']}: {$task['days_overdue']} day(s) overdue\n";
            }
            $sent += $this->notify('⚠️ Overdue maintenance', $body, 'warning');
        }

        if (!empty($due)) {
            $body = "The following maintenance tasks are coming up soon:\n\n";
            foreach ($due as $task) {
                $days = $task['days_until_due'] === 0 ? 'due TODAY' : "due in {$task['days_until_due']} day(s)";
                $body .= "• *{$task['equipment_name']}* — {$task['name']}: {$days}\n";
            }
            $sent += $this->notify('📋 Upcoming maintenance', $body, 'info');
        }

        return $sent;
    }

    private function notify(string $subject, string $body, string $level): int
    {
        $sent = 0;
        foreach ($this->notifiers as $notifier) {
            if ($notifier->isConfigured()) {
                $result = $notifier->send($subject, $body, $level);
                if ($result['success']) {
                    $sent++;
                }
            }
        }
        return $sent;
    }
}
