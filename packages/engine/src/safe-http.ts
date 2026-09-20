import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { ERROR_CODES, OUTBOUND_HTTP, type ErrorCode } from '@smartrelay/shared';
import { isBlockedAddress } from './ip';

export interface SafeHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface SafeHttpResponse {
  status: number;
  /** Lower-case header names; repeated headers are joined with ", ". */
  headers: Record<string, string>;
  /** Response body as UTF-8 text, at most `maxResponseBytes` long. */
  body: string;
  /** True when the body was cut at `maxResponseBytes`. */
  truncated: boolean;
}

/** The only way modules reach user-supplied URLs (MASTER_PLAN section 8.2). */
export interface SafeHttpClient {
  request: (request: SafeHttpRequest) => Promise<SafeHttpResponse>;
}

export type SafeHttpErrorCode = Extract<
  ErrorCode,
  'INVALID_URL' | 'INVALID_REQUEST' | 'SSRF_BLOCKED' | 'HTTP_TIMEOUT' | 'HTTP_NETWORK'
>;

/**
 * Messages never contain the URL: destination URLs can carry secrets (a Telegram bot token is
 * part of the path, webhook URLs often hold a token in the query).
 */
export class SafeHttpError extends Error {
  readonly code: SafeHttpErrorCode;
  /** Timeouts and network failures are worth retrying; policy violations are not. */
  readonly retryable: boolean;

  constructor(code: SafeHttpErrorCode, message: string) {
    super(message);
    this.name = 'SafeHttpError';
    this.code = code;
    this.retryable = code === ERROR_CODES.HTTP_TIMEOUT || code === ERROR_CODES.HTTP_NETWORK;
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SafeHttpClientOptions {
  /** Default 10 s, covering connect, response headers and body. */
  timeoutMs?: number;
  /** Default 1 MB. Longer bodies are cut and flagged `truncated`. */
  maxResponseBytes?: number;
  /** Default [80, 443]. */
  allowedPorts?: readonly number[];
  /** Replaces DNS resolution. Injected in tests. */
  resolver?: (hostname: string) => Promise<ResolvedAddress[]>;
  /**
   * Disables the private-address blocklist so tests can talk to a local server. Refused when
   * NODE_ENV is "production".
   */
  unsafeAllowPrivateAddresses?: boolean;
}

const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
]);

const defaultResolver = async (hostname: string): Promise<ResolvedAddress[]> =>
  dnsLookup(hostname, { all: true, verbatim: true });

function describeNetworkError(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `Network error (${code})` : 'Network error';
}

export function createSafeHttpClient(options: SafeHttpClientOptions = {}): SafeHttpClient {
  const timeoutMs = options.timeoutMs ?? OUTBOUND_HTTP.timeoutMs;
  const maxResponseBytes = options.maxResponseBytes ?? OUTBOUND_HTTP.maxResponseBytes;
  const allowedPorts = new Set<number>(options.allowedPorts ?? OUTBOUND_HTTP.defaultPorts);
  const resolver = options.resolver ?? defaultResolver;
  const allowPrivate = options.unsafeAllowPrivateAddresses === true;

  if (allowPrivate && process.env['NODE_ENV'] === 'production') {
    throw new Error('unsafeAllowPrivateAddresses must not be used in production');
  }

  function checkTarget(rawUrl: string): { url: URL; port: number; host: string } {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SafeHttpError(ERROR_CODES.INVALID_URL, 'Destination is not a valid URL');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SafeHttpError(ERROR_CODES.SSRF_BLOCKED, 'Only http and https URLs are allowed');
    }
    if (url.username !== '' || url.password !== '') {
      throw new SafeHttpError(
        ERROR_CODES.SSRF_BLOCKED,
        'URLs with embedded credentials are not allowed',
      );
    }

    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    if (!allowedPorts.has(port)) {
      throw new SafeHttpError(ERROR_CODES.SSRF_BLOCKED, `Port ${port} is not allowed`);
    }

    // WHATWG URL already normalized decimal/hex/octal IPv4 forms to dotted quads, and wraps IPv6
    // literals in brackets.
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(host) !== 0 && !allowPrivate && isBlockedAddress(host)) {
      throw new SafeHttpError(ERROR_CODES.SSRF_BLOCKED, 'Destination address is not allowed');
    }
    return { url, port, host };
  }

  return {
    request(request) {
      return new Promise<SafeHttpResponse>((resolve, reject) => {
        let target: ReturnType<typeof checkTarget>;
        try {
          target = checkTarget(request.url);
        } catch (error) {
          reject(error);
          return;
        }
        const { url, port, host } = target;

        let settled = false;
        let policyError: SafeHttpError | undefined;

        // Resolve once, validate every returned address, and connect only to those addresses: the
        // socket never triggers a second lookup, so DNS rebinding cannot swap in a private IP.
        const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
          resolver(hostname).then(
            (addresses) => {
              const usable = addresses.filter(
                (entry) => !lookupOptions.family || lookupOptions.family === entry.family,
              );
              if (usable.length === 0) {
                callback(
                  Object.assign(new Error('no address found'), { code: 'ENOTFOUND' }),
                  '',
                  4,
                );
                return;
              }
              if (!allowPrivate && usable.some((entry) => isBlockedAddress(entry.address))) {
                policyError = new SafeHttpError(
                  ERROR_CODES.SSRF_BLOCKED,
                  'Destination resolves to an address that is not allowed',
                );
                callback(policyError, '', 4);
                return;
              }
              if (lookupOptions.all) {
                callback(null, usable);
              } else {
                const [first] = usable;
                callback(null, first?.address ?? '', first?.family ?? 4);
              }
            },
            (error: unknown) => {
              callback(
                Object.assign(new Error('DNS lookup failed'), {
                  code: (error as { code?: string }).code ?? 'ENOTFOUND',
                }),
                '',
                4,
              );
            },
          );
        };

        const headers: Record<string, string> = { 'user-agent': 'SmartRelay/1.0', accept: '*/*' };
        for (const [name, value] of Object.entries(request.headers ?? {})) {
          const lower = name.toLowerCase();
          if (!DROPPED_REQUEST_HEADERS.has(lower)) headers[lower] = value;
        }
        // Compressed bodies would be returned undecoded (and could be decompression bombs).
        headers['accept-encoding'] = 'identity';

        const payload =
          request.body === undefined
            ? undefined
            : typeof request.body === 'string'
              ? Buffer.from(request.body, 'utf8')
              : Buffer.from(request.body);
        if (payload) headers['content-length'] = String(payload.length);

        const transport = url.protocol === 'https:' ? https : http;
        let outgoing: http.ClientRequest;
        try {
          outgoing = transport.request({
            hostname: host,
            port,
            path: `${url.pathname}${url.search}`,
            method: request.method ?? 'GET',
            headers,
            // Fresh connection per request: nothing is reused across destinations or DNS changes.
            agent: false,
            lookup,
          });
        } catch {
          // Node throws synchronously for an invalid method or header value (e.g. a newline).
          reject(
            new SafeHttpError(
              ERROR_CODES.INVALID_REQUEST,
              'Request has an invalid method or header',
            ),
          );
          return;
        }

        // `finish` is defined right after the timer that needs it; both only run asynchronously.
        const timer = setTimeout(() => {
          finish(() => reject(new SafeHttpError(ERROR_CODES.HTTP_TIMEOUT, 'Request timed out')));
          outgoing.destroy();
        }, timeoutMs);
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          action();
        };

        outgoing.on('error', (error) => {
          finish(() =>
            reject(
              policyError ??
                new SafeHttpError(ERROR_CODES.HTTP_NETWORK, describeNetworkError(error)),
            ),
          );
        });

        outgoing.on('response', (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let truncated = false;
          let complete = false;

          const build = (): SafeHttpResponse => {
            const flat: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(', ') : value;
            }
            return {
              status: response.statusCode ?? 0,
              headers: flat,
              body: Buffer.concat(chunks).toString('utf8'),
              truncated,
            };
          };

          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            const room = maxResponseBytes - received;
            if (chunk.length > room) {
              chunks.push(chunk.subarray(0, Math.max(room, 0)));
              received = maxResponseBytes;
              truncated = true;
              complete = true;
              finish(() => resolve(build()));
              response.destroy();
              return;
            }
            chunks.push(chunk);
            received += chunk.length;
          });
          response.on('end', () => {
            complete = true;
            finish(() => resolve(build()));
          });
          response.on('error', (error) => {
            finish(() =>
              reject(new SafeHttpError(ERROR_CODES.HTTP_NETWORK, describeNetworkError(error))),
            );
          });
          response.on('close', () => {
            if (!complete) {
              finish(() =>
                reject(
                  new SafeHttpError(
                    ERROR_CODES.HTTP_NETWORK,
                    'Connection closed before the response was complete',
                  ),
                ),
              );
            }
          });
        });

        outgoing.end(payload);
      });
    },
  };
}
