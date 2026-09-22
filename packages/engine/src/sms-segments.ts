// GSM 03.38 default alphabet (single-septet characters). Characters outside this set force UCS-2
// encoding. The extension table (€, [, ], {, }, ^, ~, \, |) costs two septets each in GSM-7.
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXTENDED_SET = new Set(GSM7_EXTENDED);

export interface SmsSegmentInfo {
  /** 'GSM-7' when every character fits the default alphabet, otherwise 'UCS-2'. */
  encoding: 'GSM-7' | 'UCS-2';
  segments: number;
  /** Total character count as sent, counting each GSM-7 extension character twice. */
  length: number;
}

/**
 * Estimates SMS segment count so the UI can warn when a message will be split (MASTER_PLAN
 * section 6, Module 1: "warn ... when GSM-7 segments exceed 1 and show segment count").
 */
export function calculateSmsSegments(text: string): SmsSegmentInfo {
  const characters = Array.from(text);
  const isGsm7 = characters.every(
    (char) => GSM7_BASIC_SET.has(char) || GSM7_EXTENDED_SET.has(char),
  );

  if (!isGsm7) {
    const length = characters.length;
    const segments = length <= 70 ? 1 : Math.ceil(length / 67);
    return { encoding: 'UCS-2', segments, length };
  }

  const length = characters.reduce((sum, char) => sum + (GSM7_EXTENDED_SET.has(char) ? 2 : 1), 0);
  const segments = length <= 160 ? 1 : Math.ceil(length / 153);
  return { encoding: 'GSM-7', segments, length };
}
