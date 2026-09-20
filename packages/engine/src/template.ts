import { ERROR_CODES, LIMITS, type ErrorCode } from '@smartrelay/shared';
import { JsonPathError, queryFirst, validateJsonPath } from './jsonpath';

export class TemplateError extends Error {
  readonly code: ErrorCode;
  /** The offending JSONPath from the template (never a payload value). */
  readonly path: string | undefined;

  constructor(code: ErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.path = path;
  }
}

export type TemplatePart = { kind: 'text'; text: string } | { kind: 'path'; path: string };

/**
 * Parses `Hello {{ $.customer.name }}` into text and path parts. Throws TemplateError when the
 * template is too long, has an unclosed or empty `{{ }}`, or contains an invalid JSONPath. A
 * stray `}}` outside a variable is literal text, as is a single `{` or `$`.
 */
export function parseTemplate(template: string): TemplatePart[] {
  if (template.length > LIMITS.maxTemplateLength) {
    throw new TemplateError(
      ERROR_CODES.TEMPLATE_SYNTAX,
      `Template is longer than ${LIMITS.maxTemplateLength} characters`,
    );
  }

  const parts: TemplatePart[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf('{{', cursor);
    if (open === -1) {
      parts.push({ kind: 'text', text: template.slice(cursor) });
      break;
    }
    if (open > cursor) parts.push({ kind: 'text', text: template.slice(cursor, open) });

    const close = template.indexOf('}}', open + 2);
    if (close === -1) {
      throw new TemplateError(ERROR_CODES.TEMPLATE_SYNTAX, 'Unclosed "{{" in template');
    }

    const path = template.slice(open + 2, close).trim();
    if (path.length === 0) {
      throw new TemplateError(ERROR_CODES.TEMPLATE_SYNTAX, 'Empty variable "{{ }}" in template');
    }
    try {
      validateJsonPath(path);
    } catch (error) {
      if (error instanceof JsonPathError) {
        throw new TemplateError(ERROR_CODES.JSONPATH_INVALID, error.message, path);
      }
      throw error;
    }

    parts.push({ kind: 'path', path });
    cursor = close + 2;
  }

  return parts;
}

/** All JSONPaths a template reads, in order (duplicates kept). */
export function templatePaths(template: string): string[] {
  return parseTemplate(template).flatMap((part) => (part.kind === 'path' ? [part.path] : []));
}

export interface RenderOptions {
  /**
   * Applied to each substituted value (never to the literal template text), e.g. to escape
   * Markdown for Telegram so payload data cannot break the message formatting.
   */
  escapeValue?: (value: string, path: string) => string;
}

function stringifyValue(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? String(value) : undefined;
    case 'boolean':
      return String(value);
    case 'object':
      return value === null ? undefined : JSON.stringify(value);
    default:
      return undefined;
  }
}

/**
 * Renders a template against a payload. A variable that is absent, null or not representable is a
 * terminal TEMPLATE_VAR_MISSING that names the path: the engine never sends "undefined" or "null".
 * Numbers and booleans render as plain text, objects and arrays as JSON, and "" / 0 / false are
 * valid values.
 */
export function renderTemplate(
  template: string,
  payload: unknown,
  options: RenderOptions = {},
): string {
  const parts = parseTemplate(template);
  let output = '';

  for (const part of parts) {
    if (part.kind === 'text') {
      output += part.text;
      continue;
    }

    const result = queryFirst(payload, part.path);
    const text = result.found ? stringifyValue(result.value) : undefined;
    if (text === undefined) {
      throw new TemplateError(
        ERROR_CODES.TEMPLATE_VAR_MISSING,
        `Template variable ${part.path} is missing in the payload`,
        part.path,
      );
    }
    output += options.escapeValue ? options.escapeValue(text, part.path) : text;
  }

  return output;
}
