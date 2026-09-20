import { JSONPath } from 'jsonpath-plus';
import { ERROR_CODES, LIMITS } from '@smartrelay/shared';

export class JsonPathError extends Error {
  readonly code = ERROR_CODES.JSONPATH_INVALID;

  constructor(message: string) {
    super(message);
    this.name = 'JsonPathError';
  }
}

export type PathResult = { found: true; value: unknown } | { found: false };

/*
 * SmartRelay supports a deliberately small JSONPath subset. jsonpath-plus is lenient and quirky
 * (`$[` silently returns the whole document, a quoted key containing a comma is read as a union,
 * `$.$` returns the root), so paths are checked against this strict grammar first and only
 * shapes verified to evaluate faithfully are accepted:
 *
 *   $                the whole payload
 *   .name  ..name    child / recursive descent; name = letters, digits, "_" or "-"
 *   .*  [*]          every child
 *   [0]              array index (non-negative, no leading zeros)
 *   ['key'] ["key"]  quoted key of letters, digits, space, "_", "." or "-"
 *
 * Filters, scripts, unions, slices and negative indexes are rejected.
 */
const NAME = /^[\p{L}\p{N}_-]+/u;
const QUOTED_KEY = /^\[(['"])[\p{L}\p{N} _.-]+\1\]/u;
const INDEX = /^\[(?:0|[1-9]\d*)\]/;
const BRACKET_WILDCARD = /^\[\*\]/;

/** Throws JsonPathError unless `path` is a valid path in the supported subset. */
export function validateJsonPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new JsonPathError('JSONPath must be a non-empty string');
  }
  if (path.length > LIMITS.maxJsonPathLength) {
    throw new JsonPathError(`JSONPath is longer than ${LIMITS.maxJsonPathLength} characters`);
  }
  if (!path.startsWith('$')) {
    throw new JsonPathError('JSONPath must start with "$"');
  }

  let position = 1;
  while (position < path.length) {
    const rest = path.slice(position);
    let consumed = 0;

    if (rest.startsWith('..')) {
      const name = NAME.exec(rest.slice(2));
      if (name) consumed = 2 + name[0].length;
    } else if (rest.startsWith('.*')) {
      consumed = 2;
    } else if (rest.startsWith('.')) {
      const name = NAME.exec(rest.slice(1));
      if (name) consumed = 1 + name[0].length;
    } else {
      const bracket = QUOTED_KEY.exec(rest) ?? INDEX.exec(rest) ?? BRACKET_WILDCARD.exec(rest);
      if (bracket) consumed = bracket[0].length;
    }

    if (consumed === 0) {
      throw new JsonPathError(`Unsupported or invalid JSONPath syntax at position ${position}`);
    }
    position += consumed;
  }
}

/**
 * Returns the first match of `path` in `payload`. A key that exists with the value `null` is
 * `found: true`; deciding what null means is left to the caller. Script evaluation is disabled
 * (`eval: false`), because in Node jsonpath-plus's default "safe" mode is plain `vm.Script`.
 */
export function queryFirst(payload: unknown, path: string): PathResult {
  validateJsonPath(path);
  if (payload === undefined) return { found: false };

  const matches: unknown = JSONPath({ path, json: payload as object, wrap: true, eval: false });
  if (!Array.isArray(matches) || matches.length === 0) return { found: false };
  return { found: true, value: matches[0] };
}
