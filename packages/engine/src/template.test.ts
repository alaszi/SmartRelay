import { describe, expect, it } from 'vitest';
import { parseTemplate, renderTemplate, templatePaths, TemplateError } from './template';

const payload = {
  customer: { name: 'Ana', phone: '0722123456', vip: true },
  order: { id: 1042, total: 199.9, note: '', discount: 0, paid: false, ref: null },
  items: [{ name: 'shirt' }, { name: 'shoes' }],
  tags: ['a', 'b'],
  meta: { a: 1, b: { c: 2 } },
};

function renderError(template: string, data: unknown = payload): TemplateError {
  try {
    renderTemplate(template, data);
  } catch (error) {
    if (error instanceof TemplateError) return error;
    throw error;
  }
  throw new Error('expected renderTemplate to throw');
}

describe('renderTemplate: substitution', () => {
  it('replaces a variable', () => {
    expect(renderTemplate('Hello {{$.customer.name}}!', payload)).toBe('Hello Ana!');
  });

  it('tolerates whitespace and newlines inside the braces', () => {
    expect(renderTemplate('{{ $.customer.name }}', payload)).toBe('Ana');
    expect(renderTemplate('{{   $.customer.name}}', payload)).toBe('Ana');
    expect(renderTemplate('{{$.customer.name   }}', payload)).toBe('Ana');
    expect(renderTemplate('{{\n\t$.customer.name\n}}', payload)).toBe('Ana');
  });

  it('handles several variables, repeats and adjacent variables', () => {
    expect(renderTemplate('{{$.customer.name}} #{{$.order.id}}', payload)).toBe('Ana #1042');
    expect(renderTemplate('{{$.customer.name}}{{$.customer.name}}', payload)).toBe('AnaAna');
    expect(renderTemplate('{{$.order.id}}{{$.order.total}}', payload)).toBe('1042199.9');
  });

  it('returns text without variables unchanged, including the empty string', () => {
    expect(renderTemplate('no variables here', payload)).toBe('no variables here');
    expect(renderTemplate('', payload)).toBe('');
  });

  it('uses the first match of a multi-match path', () => {
    expect(renderTemplate('{{$.items[*].name}}', payload)).toBe('shirt');
    expect(renderTemplate('{{$..name}}', payload)).toBe('Ana');
    expect(renderTemplate('{{$.items[1].name}}', payload)).toBe('shoes');
  });

  it('keeps unicode intact', () => {
    expect(renderTemplate('Szia {{$.n}} 👋 ș ț ă', { n: 'Ilona Kovács' })).toBe(
      'Szia Ilona Kovács 👋 ș ț ă',
    );
  });

  it('does not interpret $ or single braces in literal text', () => {
    expect(renderTemplate('Price: $5 { not a var } {$.customer.name}', payload)).toBe(
      'Price: $5 { not a var } {$.customer.name}',
    );
  });

  it('treats a stray "}}" outside a variable as literal text', () => {
    expect(renderTemplate('a }} b {{$.customer.name}} }}', payload)).toBe('a }} b Ana }}');
  });

  it('does not re-expand template syntax found inside payload values', () => {
    expect(renderTemplate('{{$.x}}', { x: '{{$.secret}}', secret: 'nope' })).toBe('{{$.secret}}');
  });
});

describe('renderTemplate: value types', () => {
  it('renders numbers and booleans as plain text', () => {
    expect(renderTemplate('{{$.order.id}}', payload)).toBe('1042');
    expect(renderTemplate('{{$.order.total}}', payload)).toBe('199.9');
    expect(renderTemplate('{{$.customer.vip}}', payload)).toBe('true');
  });

  it('renders falsy but present values instead of treating them as missing', () => {
    expect(renderTemplate('[{{$.order.note}}]', payload)).toBe('[]');
    expect(renderTemplate('{{$.order.discount}}', payload)).toBe('0');
    expect(renderTemplate('{{$.order.paid}}', payload)).toBe('false');
  });

  it('renders objects and arrays as JSON', () => {
    expect(renderTemplate('{{$.tags}}', payload)).toBe('["a","b"]');
    expect(renderTemplate('{{$.meta}}', payload)).toBe('{"a":1,"b":{"c":2}}');
    expect(renderTemplate('{{$.items[0]}}', payload)).toBe('{"name":"shirt"}');
  });

  it('renders the whole payload for "$"', () => {
    expect(renderTemplate('{{$}}', { a: 1 })).toBe('{"a":1}');
    expect(renderTemplate('{{$}}', 'plain')).toBe('plain');
  });
});

describe('renderTemplate: missing variables (TEMPLATE_VAR_MISSING)', () => {
  it('throws a terminal error that names the path', () => {
    const error = renderError('Hi {{$.customer.email}}');
    expect(error.code).toBe('TEMPLATE_VAR_MISSING');
    expect(error.path).toBe('$.customer.email');
    expect(error.message).toContain('$.customer.email');
  });

  it('never silently produces "undefined" or "null"', () => {
    for (const template of ['{{$.nope}}', '{{$.order.ref}}', '{{$.items[9].name}}']) {
      expect(renderError(template).code).toBe('TEMPLATE_VAR_MISSING');
    }
  });

  it('treats a null value as missing', () => {
    const error = renderError('{{$.order.ref}}');
    expect(error.code).toBe('TEMPLATE_VAR_MISSING');
    expect(error.path).toBe('$.order.ref');
  });

  it('reports the first missing variable and does not include payload values in the message', () => {
    const secretPayload = { token: 'super-secret-token-value' };
    const error = renderError('{{$.token}} {{$.absent}}', secretPayload);
    expect(error.path).toBe('$.absent');
    expect(error.message).not.toContain('super-secret-token-value');
  });

  it('fails on a missing variable when the payload is not an object', () => {
    expect(renderError('{{$.a}}', 'text').code).toBe('TEMPLATE_VAR_MISSING');
    expect(renderError('{{$.a}}', null).code).toBe('TEMPLATE_VAR_MISSING');
    expect(renderError('{{$.a}}', undefined).code).toBe('TEMPLATE_VAR_MISSING');
  });

  it('does not resolve prototype properties as values', () => {
    expect(renderError('{{$.constructor}}', {}).code).toBe('TEMPLATE_VAR_MISSING');
    expect(renderError('{{$.__proto__}}', {}).code).toBe('TEMPLATE_VAR_MISSING');
    expect(renderError('{{$.toString}}', {}).code).toBe('TEMPLATE_VAR_MISSING');
  });
});

describe('parseTemplate: syntax errors (TEMPLATE_SYNTAX / JSONPATH_INVALID)', () => {
  it.each([
    ['unclosed brace', 'Hello {{$.a'],
    ['unclosed after text', 'Hello {{$.a} world'],
    ['empty variable', 'Hello {{}}'],
    ['whitespace-only variable', 'Hello {{   }}'],
    ['nested braces', '{{ {{$.a}} }}'],
    ['triple braces', '{{{$.a}}}'],
    ['variable without leading $', '{{customer.name}}'],
  ])('rejects %s', (_label, template) => {
    expect(() => parseTemplate(template)).toThrow(TemplateError);
  });

  it('uses TEMPLATE_SYNTAX for structural problems', () => {
    expect(renderError('Hello {{$.a').code).toBe('TEMPLATE_SYNTAX');
    expect(renderError('{{}}').code).toBe('TEMPLATE_SYNTAX');
  });

  it('uses JSONPATH_INVALID and names the path for invalid paths', () => {
    for (const path of ['$.a[', '$..', '$.items[?(@.x)]', 'customer.name']) {
      const error = renderError(`Hi {{${path}}}`);
      expect(error.code).toBe('JSONPATH_INVALID');
      expect(error.path).toBe(path);
    }
  });

  it('enforces the 2 KB length limit', () => {
    const ok = 'x'.repeat(2048);
    expect(parseTemplate(ok)).toEqual([{ kind: 'text', text: ok }]);
    expect(renderError('x'.repeat(2049)).code).toBe('TEMPLATE_SYNTAX');
  });

  it('validates at save time without a payload', () => {
    expect(() => parseTemplate('Hello {{$.customer.name}}, order {{$.order.id}}')).not.toThrow();
  });
});

describe('parseTemplate / templatePaths', () => {
  it('splits text and path parts in order', () => {
    expect(parseTemplate('a {{$.x}} b {{ $.y }} c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'path', path: '$.x' },
      { kind: 'text', text: ' b ' },
      { kind: 'path', path: '$.y' },
      { kind: 'text', text: ' c' },
    ]);
  });

  it('lists every path a template reads', () => {
    expect(templatePaths('{{$.a}} and {{$.b.c}} and {{$.a}}')).toEqual(['$.a', '$.b.c', '$.a']);
    expect(templatePaths('no variables')).toEqual([]);
  });
});

describe('escapeValue option', () => {
  const escapeMarkdown = (value: string) => value.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');

  it('escapes substituted values but not the literal template text', () => {
    const output = renderTemplate(
      '*Order* {{$.note}}',
      { note: 'a_b*c [x](y)' },
      {
        escapeValue: escapeMarkdown,
      },
    );
    expect(output).toBe('*Order* a\\_b\\*c \\[x\\]\\(y\\)');
  });

  it('receives the path of each value', () => {
    const seen: string[] = [];
    renderTemplate(
      '{{$.a}} {{$.b}}',
      { a: 1, b: 2 },
      {
        escapeValue: (value, path) => {
          seen.push(path);
          return value;
        },
      },
    );
    expect(seen).toEqual(['$.a', '$.b']);
  });
});
