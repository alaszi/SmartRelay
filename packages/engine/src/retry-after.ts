/**
 * Parses a standard HTTP `Retry-After` header value: either a number of seconds, or an HTTP-date.
 * Returns milliseconds from `now`, or undefined when the value is missing or unparsable.
 * MASTER_PLAN section 5: "Retryable = ... 429 (honor Retry-After if larger than the backoff)".
 */
export function parseRetryAfterMs(
  value: string | undefined,
  now: Date = new Date(),
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const deltaMs = date - now.getTime();
  return deltaMs > 0 ? deltaMs : undefined;
}
