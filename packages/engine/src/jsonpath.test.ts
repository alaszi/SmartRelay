import { describe, expect, it } from 'vitest';
import { JsonPathError, queryFirst, validateJsonPath } from './jsonpath';

const doc = {
  order: { id: 1042, total: 199.9, paid: false, note: '', ref: null },
  items: [{ name: 'shirt' }, { name: 'shoes' }],
  customer: { 'first-name': 'Ana', név: 'Ilona', 'phone number': '0722 123 456' },
  'a.b': 'dotted',
  '1': 'one',
  $: 'dollar key',
  nested: { deeper: { name: 'deep' } },
};

describe('validateJsonPath', () => {
  it.each([
    '$',
    '$.a',
    '$.a.b.c',
    '$.a-b',
    '$.a_b',
    '$.név',
    '$.123',
    '$.items[0]',
    '$.items[12].name',
    '$.items[*].name',
    '$.items.*',
    '$..name',
    '$.nested..name',
    "$['a b']",
    '$["a b"]',
    "$['a.b']",
    "$['a-b']",
    "$['items'][0]['name']",
    '$.a[0][1]',
  ])('accepts %s', (path) => {
    expect(() => validateJsonPath(path)).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['a.b', 'no leading $'],
    ['.a', 'leading dot'],
    ['$.', 'trailing dot'],
    ['$[', 'unterminated bracket'],
    ['$.items[', 'unterminated bracket after key'],
    ['$..', 'bare recursive descent'],
    ['$...a', 'triple dot'],
    ['$..[0]', 'recursive descent into bracket'],
    ['$.a..', 'trailing recursive descent'],
    ['$.a b', 'unquoted space'],
    ['$.a,b', 'comma outside brackets'],
    ['$[0,1]', 'union'],
    ['$[0:2]', 'slice'],
    ['$.items[-1]', 'negative index'],
    ['$.items[00]', 'leading zero index'],
    ['$.items[1.5]', 'fractional index'],
    ['$.items[+1]', 'signed index'],
    ['$.items[?(@.name=="x")]', 'filter expression'],
    ['$.items[(@.length-1)]', 'script expression'],
    ['$.items[?@.name]', 'filter without parentheses'],
    ['$.a~', 'property-name operator'],
    ['$.a^', 'parent operator'],
    ['@.a', 'current-node reference'],
    ['$.a@string()', 'type selector'],
    ['@other()', 'other() operator'],
    ["$['a,b']", 'comma inside quoted key'],
    ["$['*']", 'wildcard inside quoted key'],
    ["$['$']", 'dollar inside quoted key'],
    ["$['it\\'s']", 'escaped quote'],
    ['$["it\'s"]', 'quote inside quoted key'],
    ["$['wei]rd']", 'bracket inside quoted key'],
    ["$['']", 'empty quoted key'],
    ['$[\'a"]', 'mismatched quotes'],
    ['$.$', 'dollar as a name'],
    ['$.a\n', 'trailing newline'],
    ['$.a;drop', 'trailing garbage'],
  ])('rejects %j (%s)', (path) => {
    expect(() => validateJsonPath(path)).toThrow(JsonPathError);
  });

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 5, {}, ['$.a']]) {
      expect(() => validateJsonPath(value)).toThrow(JsonPathError);
    }
  });

  it('enforces the maximum length of 256 characters', () => {
    expect(() => validateJsonPath(`$.${'a'.repeat(254)}`)).not.toThrow();
    expect(() => validateJsonPath(`$.${'a'.repeat(255)}`)).toThrow(/longer than 256/);
  });

  it('reports a stable error code and the failing position', () => {
    try {
      validateJsonPath('$.a[');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(JsonPathError);
      expect((error as JsonPathError).code).toBe('JSONPATH_INVALID');
      expect((error as JsonPathError).message).toContain('position 3');
    }
  });
});

describe('queryFirst', () => {
  it('reads values, including falsy ones', () => {
    expect(queryFirst(doc, '$.order.id')).toEqual({ found: true, value: 1042 });
    expect(queryFirst(doc, '$.order.total')).toEqual({ found: true, value: 199.9 });
    expect(queryFirst(doc, '$.order.paid')).toEqual({ found: true, value: false });
    expect(queryFirst(doc, '$.order.note')).toEqual({ found: true, value: '' });
  });

  it('distinguishes null from missing', () => {
    expect(queryFirst(doc, '$.order.ref')).toEqual({ found: true, value: null });
    expect(queryFirst(doc, '$.order.nothing')).toEqual({ found: false });
    expect(queryFirst(doc, '$.a.b.c.d')).toEqual({ found: false });
  });

  it('returns the first match for multi-match paths', () => {
    expect(queryFirst(doc, '$.items[*].name')).toEqual({ found: true, value: 'shirt' });
    expect(queryFirst(doc, '$..name')).toEqual({ found: true, value: 'shirt' });
    expect(queryFirst(doc, '$.items[1].name')).toEqual({ found: true, value: 'shoes' });
    expect(queryFirst(doc, '$.items[5].name')).toEqual({ found: false });
  });

  it('returns objects and arrays as values', () => {
    expect(queryFirst(doc, '$.items[0]')).toEqual({ found: true, value: { name: 'shirt' } });
    expect(queryFirst(doc, '$.items')).toEqual({ found: true, value: doc.items });
  });

  // Every accepted shape must evaluate to the right thing, because jsonpath-plus has quirks.
  it.each([
    ['$.customer.first-name', 'Ana'],
    ['$.customer.név', 'Ilona'],
    ["$.customer['phone number']", '0722 123 456'],
    ['$.customer["first-name"]', 'Ana'],
    ["$['a.b']", 'dotted'],
    ['$.1', 'one'],
    ['$[1]', 'one'],
    ["$['items'][1]['name']", 'shoes'],
    ['$.nested..name', 'deep'],
    ['$.nested.deeper.name', 'deep'],
  ])('evaluates %s faithfully', (path, expected) => {
    expect(queryFirst(doc, path)).toEqual({ found: true, value: expected });
  });

  it('never resolves prototype properties', () => {
    for (const path of ['$.__proto__', '$.constructor', '$.constructor.prototype', '$.toString']) {
      expect(queryFirst({}, path)).toEqual({ found: false });
      expect(queryFirst(doc, path)).toEqual({ found: false });
    }
  });

  it('does not execute filter or script expressions', () => {
    const sideEffect = { ran: false };
    (globalThis as Record<string, unknown>)['__smartrelaySideEffect'] = sideEffect;

    expect(() =>
      queryFirst(doc, '$.items[?(globalThis.__smartrelaySideEffect.ran = true)]'),
    ).toThrow(JsonPathError);
    expect(() =>
      queryFirst(doc, "$.items[(this.constructor.constructor('return process')())]"),
    ).toThrow(JsonPathError);

    expect(sideEffect.ran).toBe(false);
    delete (globalThis as Record<string, unknown>)['__smartrelaySideEffect'];
  });

  it('handles non-object payloads', () => {
    expect(queryFirst('plain text', '$')).toEqual({ found: true, value: 'plain text' });
    expect(queryFirst(42, '$')).toEqual({ found: true, value: 42 });
    expect(queryFirst('plain text', '$.a')).toEqual({ found: false });
    expect(queryFirst(null, '$')).toEqual({ found: false });
    expect(queryFirst(undefined, '$')).toEqual({ found: false });
  });

  it('handles arrays at the root', () => {
    expect(queryFirst([{ id: 1 }, { id: 2 }], '$[1].id')).toEqual({ found: true, value: 2 });
  });

  it('validates the path before evaluating it', () => {
    expect(() => queryFirst(doc, '$[')).toThrow(JsonPathError);
    expect(() => queryFirst(doc, '')).toThrow(JsonPathError);
  });
});
