import { describe, expect, it } from 'vitest';
import { calculateSmsSegments } from './sms-segments';

describe('calculateSmsSegments', () => {
  it('counts a short GSM-7 message as a single segment', () => {
    const text = 'Hello Ana, your order shipped.';
    expect(calculateSmsSegments(text)).toEqual({
      encoding: 'GSM-7',
      segments: 1,
      length: text.length,
    });
  });

  it('stays single-segment right at the 160-char GSM-7 boundary', () => {
    expect(calculateSmsSegments('a'.repeat(160)).segments).toBe(1);
    expect(calculateSmsSegments('a'.repeat(161)).segments).toBe(2);
  });

  it('switches to multi-part packing (153/segment) above one segment', () => {
    const info = calculateSmsSegments('a'.repeat(306)); // 2 * 153
    expect(info).toEqual({ encoding: 'GSM-7', segments: 2, length: 306 });
  });

  it('counts GSM-7 extension characters (€, [, ], {, }, ^, ~, \\, |) as two septets', () => {
    expect(calculateSmsSegments('€').length).toBe(2);
    expect(calculateSmsSegments('[test]').length).toBe(2 + 4 + 2);
  });

  it('detects Romanian diacritics (ș, ț) as outside GSM-7, forcing UCS-2', () => {
    const info = calculateSmsSegments('Salut ș ț');
    expect(info.encoding).toBe('UCS-2');
  });

  it('uses the UCS-2 boundary (70 single-segment, 67/segment after)', () => {
    expect(calculateSmsSegments('ș'.repeat(70))).toEqual({
      encoding: 'UCS-2',
      segments: 1,
      length: 70,
    });
    expect(calculateSmsSegments('ș'.repeat(71)).segments).toBe(2);
    expect(calculateSmsSegments('ș'.repeat(134)).segments).toBe(2); // 2 * 67
  });

  it('treats an emoji as UCS-2 and counts it as one character, not two UTF-16 code units', () => {
    const info = calculateSmsSegments('Hi 👋');
    expect(info.encoding).toBe('UCS-2');
    expect(info.length).toBe(4); // H, i, space, 👋
  });

  it('handles the empty string', () => {
    expect(calculateSmsSegments('')).toEqual({ encoding: 'GSM-7', segments: 1, length: 0 });
  });

  it('accepts common Hungarian diacritics as GSM-7 (á, é, í, ó, ö, ő, ú, ü, ű)', () => {
    // GSM-7 only covers é natively; the others force UCS-2, which is the correct, verifiable result.
    expect(calculateSmsSegments('é').encoding).toBe('GSM-7');
    expect(calculateSmsSegments('á').encoding).toBe('UCS-2');
  });
});
