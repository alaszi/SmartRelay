/**
 * Truncates to at most `maxBytes` UTF-8 bytes without cutting a multi-byte character in half,
 * so the result always fits a byte-limited column (event_payloads.response_excerpt: 8 KB).
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;

  let end = maxBytes;
  // 0b10xxxxxx marks a continuation byte: step back to the start of the character we would split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
