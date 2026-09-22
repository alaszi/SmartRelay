/** Job name and payload shape shared by the API (enqueues) and the worker (processes). */
export const DELIVER_QUEUE_NAME = 'deliver';

export interface DeliverJobData {
  eventId: string;
}

/** `attempts: 4` (initial + 3 retries) with these delays, per the plan (section 5). */
export const DELIVER_RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;
export const DELIVER_MAX_ATTEMPTS = DELIVER_RETRY_DELAYS_MS.length + 1;

/** Backoff strategy for BullMQ: returns undefined once attempts are exhausted (no more retries). */
export function deliverBackoffMs(attemptsMade: number): number | undefined {
  return DELIVER_RETRY_DELAYS_MS[attemptsMade - 1];
}
