<?php

declare(strict_types=1);

namespace SmartRelay\Core;

/**
 * Base contract for all SmartRelay services.
 *
 * Every service (alert, CMMS, notifier, collector) implements this interface.
 * This keeps the architecture plug-and-play: new services drop in without
 * touching existing code.
 */
interface ServiceInterface
{
    /**
     * Human-readable name of the service (used in logs and reports).
     */
    public function getName(): string;

    /**
     * Returns true if the service is properly configured and ready to run.
     * Called before execute() to prevent partial failures.
     */
    public function isReady(): bool;

    /**
     * Run the service. Returns a result array with at minimum:
     *   ['success' => bool, 'message' => string, 'data' => mixed]
     */
    public function execute(): array;
}
