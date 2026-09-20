import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSafeHttpClient,
  SafeHttpError,
  type ResolvedAddress,
  type SafeHttpClientOptions,
} from './safe-http';

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  port: number;
  requests: Received[];
}

const servers: http.Server[] = [];

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse, received: Received) => void,
): Promise<TestServer> {
  const requests: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const received: Received = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(received);
      handler(request, response, received);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function failure(promise: Promise<unknown>): Promise<SafeHttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeHttpError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

/** A client that may reach the local test servers. */
const localClient = (port: number, options: SafeHttpClientOptions = {}) =>
  createSafeHttpClient({ unsafeAllowPrivateAddresses: true, allowedPorts: [port], ...options });

const answering =
  (address: string, family = 4) =>
  async (): Promise<ResolvedAddress[]> => [{ address, family }];

describe('blocked destinations never reach the network', () => {
  it.each([
    'http://127.0.0.1:{p}/',
    'http://[::1]:{p}/',
    'http://[::ffff:127.0.0.1]:{p}/',
    'http://[::ffff:7f00:1]:{p}/',
    'http://0.0.0.0:{p}/',
    'http://10.0.0.1:{p}/',
    'http://172.16.0.1:{p}/',
    'http://192.168.1.1:{p}/',
    'http://169.254.169.254:{p}/latest/meta-data/iam/security-credentials/',
    'http://[fd00:ec2::254]:{p}/',
    'http://100.64.0.1:{p}/',
    'http://[fd00::1]:{p}/',
    'http://[fe80::1]:{p}/',
    'http://[64:ff9b::7f00:1]:{p}/',
    'http://[2002:7f00:1::]:{p}/',
    // obfuscated spellings of 127.0.0.1 that URL normalization must not let through
    'http://2130706433:{p}/',
    'http://0x7f000001:{p}/',
    'http://0177.0.0.1:{p}/',
    'http://127.1:{p}/',
    'http://127.0.0.1.:{p}/',
  ])('blocks %s', async (template) => {
    const canary = await startServer((_req, res) => res.end('reached'));
    const client = createSafeHttpClient({ allowedPorts: [canary.port] });

    const error = await failure(
      client.request({ url: template.replace('{p}', String(canary.port)) }),
    );

    expect(error.code).toBe('SSRF_BLOCKED');
    expect(error.retryable).toBe(false);
    expect(canary.requests).toHaveLength(0);
  });

  it.each([
    'ftp://example.com/file',
    'file:///etc/passwd',
    'gopher://example.com/',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'ws://example.com/',
    'HTTPS-not-really://example.com/',
  ])('rejects the scheme in %s', async (url) => {
    const error = await failure(createSafeHttpClient().request({ url }));
    expect(['SSRF_BLOCKED', 'INVALID_URL']).toContain(error.code);
    expect(error.retryable).toBe(false);
  });

  it.each(['', 'not a url', 'http://', '//example.com', 'example.com', 'http://exa mple.com/'])(
    'reports INVALID_URL for %j',
    async (url) => {
      const error = await failure(createSafeHttpClient().request({ url }));
      expect(error.code).toBe('INVALID_URL');
      expect(error.retryable).toBe(false);
    },
  );

  it.each([
    ['a newline in a header value', { method: 'GET', headers: { 'x-a': 'v\r\nInjected: 1' } }],
    ['a newline in a header name', { method: 'GET', headers: { 'x-a\r\nInjected': 'v' } }],
    ['an invalid method', { method: 'BAD METHOD', headers: {} }],
  ])('reports INVALID_REQUEST for %s instead of throwing a raw error', async (_label, extra) => {
    const canary = await startServer((_req, res) => res.end('reached'));

    const error = await failure(
      localClient(canary.port).request({ url: `http://127.0.0.1:${canary.port}/`, ...extra }),
    );

    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.retryable).toBe(false);
    expect(canary.requests).toHaveLength(0);
  });

  it('rejects URLs with embedded credentials', async () => {
    const error = await failure(
      createSafeHttpClient({ resolver: answering('8.8.8.8') }).request({
        url: 'https://user:pass@example.com/',
      }),
    );
    expect(error.code).toBe('SSRF_BLOCKED');
  });

  describe('ports', () => {
    it.each([8080, 22, 25, 3306, 6379, 5432, 1, 0, 65535])(
      'blocks port %s by default',
      async (port) => {
        const error = await failure(
          createSafeHttpClient({ resolver: answering('8.8.8.8') }).request({
            url: `http://example.test:${port}/`,
          }),
        );
        expect(error.code).toBe('SSRF_BLOCKED');
        expect(error.message).toBe(`Port ${port} is not allowed`);
      },
    );

    it('lets ports 80 and 443 through the port check (they are then judged by address)', async () => {
      for (const url of [
        'http://example.test/',
        'http://example.test:80/',
        'https://example.test/',
      ]) {
        const error = await failure(
          createSafeHttpClient({ resolver: answering('10.0.0.1') }).request({ url }),
        );
        expect(error.message).toContain('address');
      }
    });

    it('honours an explicit allow-list', async () => {
      const error = await failure(
        createSafeHttpClient({ allowedPorts: [8443], resolver: answering('10.0.0.1') }).request({
          url: 'https://example.test:8443/',
        }),
      );
      expect(error.message).toContain('address');

      const blocked = await failure(
        createSafeHttpClient({ allowedPorts: [8443] }).request({ url: 'https://example.test/' }),
      );
      expect(blocked.message).toBe('Port 443 is not allowed');
    });
  });

  describe('hostnames that resolve to private addresses', () => {
    it.each([
      ['loopback', [{ address: '127.0.0.1', family: 4 }]],
      ['metadata service', [{ address: '169.254.169.254', family: 4 }]],
      ['RFC 1918', [{ address: '10.1.2.3', family: 4 }]],
      ['IPv6 loopback', [{ address: '::1', family: 6 }]],
      ['IPv6 ULA', [{ address: 'fd00::1', family: 6 }]],
      ['IPv4-mapped loopback', [{ address: '::ffff:127.0.0.1', family: 6 }]],
      [
        'one public and one private address',
        [
          { address: '8.8.8.8', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ],
      ],
    ])('blocks a name resolving to %s', async (_label, addresses) => {
      const canary = await startServer((_req, res) => res.end('reached'));
      const client = createSafeHttpClient({
        allowedPorts: [canary.port],
        resolver: async () => addresses,
      });

      const error = await failure(client.request({ url: `http://evil.example:${canary.port}/` }));

      expect(error.code).toBe('SSRF_BLOCKED');
      expect(error.retryable).toBe(false);
      expect(canary.requests).toHaveLength(0);
    });

    it('treats a name that does not resolve as a retryable network error, not a policy block', async () => {
      const error = await failure(
        createSafeHttpClient({
          resolver: async () => {
            throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
          },
        }).request({ url: 'http://does-not-exist.example/' }),
      );
      expect(error.code).toBe('HTTP_NETWORK');
      expect(error.retryable).toBe(true);
    });

    it('treats an empty DNS answer as a retryable network error', async () => {
      const error = await failure(
        createSafeHttpClient({ resolver: async () => [] }).request({
          url: 'http://empty.example/',
        }),
      );
      expect(error.code).toBe('HTTP_NETWORK');
      expect(error.retryable).toBe(true);
    });
  });

  it('never puts the URL, path or query in error messages (they can carry tokens)', async () => {
    const canary = await startServer((_req, res) => res.end('x'));
    const silent = await startServer(() => {
      /* never respond, to provoke a timeout */
    });
    const secretPath = `/bot123456:SECRET-TOKEN/sendMessage?key=SECRET-KEY`;
    const cases: Promise<SafeHttpError>[] = [
      failure(
        createSafeHttpClient({ allowedPorts: [canary.port] }).request({
          url: `http://127.0.0.1:${canary.port}${secretPath}`,
        }),
      ),
      failure(
        createSafeHttpClient({
          allowedPorts: [canary.port],
          resolver: answering('10.0.0.1'),
        }).request({
          url: `http://secret-host.example:${canary.port}${secretPath}`,
        }),
      ),
      failure(createSafeHttpClient().request({ url: `ftp://secret-host.example${secretPath}` })),
      failure(
        localClient(silent.port, { timeoutMs: 100 }).request({
          url: `http://127.0.0.1:${silent.port}${secretPath}`,
          method: 'POST',
        }),
      ),
    ];

    const errors = await Promise.all(cases);
    expect(errors.map((error) => error.code)).toEqual([
      'SSRF_BLOCKED',
      'SSRF_BLOCKED',
      'SSRF_BLOCKED',
      'HTTP_TIMEOUT',
    ]);
    for (const error of errors) {
      expect(error.message).not.toContain('SECRET');
      expect(error.message).not.toContain('secret-host');
      expect(error.message).not.toContain('bot123456');
    }
  });

  it('refuses to be created in permissive mode when NODE_ENV is production', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => createSafeHttpClient({ unsafeAllowPrivateAddresses: true })).toThrow(
        /production/,
      );
      expect(() => createSafeHttpClient()).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
});

describe('requests', () => {
  it('returns status, headers and body', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-custom': 'yes' });
      res.end('{"ok":true}');
    });

    const response = await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/`,
    });

    expect(response.status).toBe(201);
    expect(response.body).toBe('{"ok":true}');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['x-custom']).toBe('yes');
    expect(response.truncated).toBe(false);
  });

  it('sends method, body and headers, and computes the content length in bytes', async () => {
    const server = await startServer((_req, res) => res.end('ok'));
    const body = JSON.stringify({ name: 'Kovács Ilona ș ț 👋' });

    await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/hook`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'abc' },
      body,
    });

    const [received] = server.requests;
    expect(received?.method).toBe('POST');
    expect(received?.url).toBe('/hook');
    expect(received?.body).toBe(body);
    expect(received?.headers['content-type']).toBe('application/json');
    expect(received?.headers['x-api-key']).toBe('abc');
    expect(received?.headers['content-length']).toBe(String(Buffer.byteLength(body)));
  });

  it('sends binary request bodies unchanged', async () => {
    const server = await startServer((_req, res) => res.end('ok'));
    await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/`,
      method: 'POST',
      body: new Uint8Array([104, 105]),
    });
    expect(server.requests[0]?.body).toBe('hi');
  });

  it('preserves path and query string exactly', async () => {
    const server = await startServer((_req, res) => res.end('ok'));
    await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/a/b%20c/d?x=1&y=%20z&empty=`,
    });
    expect(server.requests[0]?.url).toBe('/a/b%20c/d?x=1&y=%20z&empty=');
  });

  it('sets a User-Agent and asks for an uncompressed body', async () => {
    const server = await startServer((_req, res) => res.end('ok'));
    await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/`,
      headers: { 'Accept-Encoding': 'gzip, br' },
    });
    expect(server.requests[0]?.headers['user-agent']).toBe('SmartRelay/1.0');
    expect(server.requests[0]?.headers['accept-encoding']).toBe('identity');
  });

  it('does not let callers override Host, Content-Length or hop-by-hop headers', async () => {
    const server = await startServer((_req, res) => res.end('ok'));
    await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/`,
      method: 'POST',
      headers: {
        Host: 'evil.example',
        'Content-Length': '999',
        'Transfer-Encoding': 'chunked',
        Connection: 'keep-alive',
        Upgrade: 'websocket',
      },
      body: 'abc',
    });

    const [received] = server.requests;
    expect(received?.headers['host']).toBe(`127.0.0.1:${server.port}`);
    expect(received?.headers['content-length']).toBe('3');
    expect(received?.headers['transfer-encoding']).toBeUndefined();
    expect(received?.headers['upgrade']).toBeUndefined();
    expect(received?.body).toBe('abc');
  });

  it('returns 4xx and 5xx responses instead of throwing', async () => {
    const server = await startServer((request, res) => {
      res.writeHead(request.url === '/five' ? 503 : 404, { 'retry-after': '30' });
      res.end('nope');
    });
    const client = localClient(server.port);

    const notFound = await client.request({ url: `http://127.0.0.1:${server.port}/x` });
    const unavailable = await client.request({ url: `http://127.0.0.1:${server.port}/five` });

    expect(notFound.status).toBe(404);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers['retry-after']).toBe('30');
    expect(unavailable.body).toBe('nope');
  });

  it('handles empty bodies and multi-byte text', async () => {
    const server = await startServer((request, res) => {
      if (request.url === '/empty') {
        res.writeHead(204);
        res.end();
      } else {
        res.end('Szia Ilona 👋 ș ț');
      }
    });
    const client = localClient(server.port);

    expect((await client.request({ url: `http://127.0.0.1:${server.port}/empty` })).body).toBe('');
    expect((await client.request({ url: `http://127.0.0.1:${server.port}/text` })).body).toBe(
      'Szia Ilona 👋 ș ț',
    );
  });

  it('joins repeated response headers', async () => {
    const server = await startServer((_req, res) => {
      res.setHeader('x-multi', ['a', 'b']);
      res.end('ok');
    });
    const response = await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/`,
    });
    expect(response.headers['x-multi']).toBe('a, b');
  });
});

describe('redirects', () => {
  it('does not follow them and returns the 3xx response', async () => {
    const target = await startServer((_req, res) => res.end('should not be reached'));
    const redirector = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/secret` });
      res.end();
    });

    const response = await localClient(redirector.port).request({
      url: `http://127.0.0.1:${redirector.port}/go`,
    });

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe(`http://127.0.0.1:${target.port}/secret`);
    expect(redirector.requests).toHaveLength(1);
    expect(target.requests).toHaveLength(0);
  });

  it.each([301, 302, 303, 307, 308])(
    'does not follow a %s to the metadata address',
    async (status) => {
      const server = await startServer((_req, res) => {
        res.writeHead(status, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      });

      const response = await localClient(server.port).request({
        url: `http://127.0.0.1:${server.port}/`,
        method: 'POST',
        body: 'x',
      });

      expect(response.status).toBe(status);
      expect(server.requests).toHaveLength(1);
    },
  );
});

describe('DNS handling', () => {
  it('connects to the validated address and keeps the hostname in the Host header', async () => {
    const server = await startServer((_req, res) => res.end('ok'));
    let lookups = 0;
    const client = createSafeHttpClient({
      unsafeAllowPrivateAddresses: true,
      allowedPorts: [server.port],
      resolver: async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });

    const response = await client.request({ url: `http://webshop.example:${server.port}/hook` });

    expect(response.status).toBe(200);
    expect(server.requests[0]?.headers['host']).toBe(`webshop.example:${server.port}`);
    expect(lookups).toBe(1);
  });

  it('does not resolve IP literals at all', async () => {
    const server = await startServer((_req, res) => res.end('ok'));
    let lookups = 0;
    const client = createSafeHttpClient({
      unsafeAllowPrivateAddresses: true,
      allowedPorts: [server.port],
      resolver: async () => {
        lookups++;
        return [];
      },
    });

    await client.request({ url: `http://127.0.0.1:${server.port}/` });
    expect(lookups).toBe(0);
  });
});

describe('timeouts and failures', () => {
  it('times out when the server never answers (retryable)', async () => {
    const server = await startServer(() => {
      /* never respond */
    });
    const started = Date.now();

    const error = await failure(
      localClient(server.port, { timeoutMs: 200 }).request({
        url: `http://127.0.0.1:${server.port}/`,
      }),
    );

    expect(error.code).toBe('HTTP_TIMEOUT');
    expect(error.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('times out when the body stalls after the headers arrived', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
    });

    const error = await failure(
      localClient(server.port, { timeoutMs: 200 }).request({
        url: `http://127.0.0.1:${server.port}/`,
      }),
    );

    expect(error.code).toBe('HTTP_TIMEOUT');
  });

  it('reports a refused connection as a retryable network error without the URL', async () => {
    const closed = await startServer((_req, res) => res.end());
    const port = closed.port;
    await new Promise<void>((resolve) => {
      servers[servers.length - 1]?.closeAllConnections();
      servers[servers.length - 1]?.close(() => resolve());
    });

    const error = await failure(
      localClient(port).request({ url: `http://127.0.0.1:${port}/private/path?token=abc` }),
    );

    expect(error.code).toBe('HTTP_NETWORK');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).not.toContain('private/path');
    expect(error.message).not.toContain('token=abc');
  });

  it('reports a connection dropped mid-response as a network error', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 20);
    });

    const error = await failure(
      localClient(server.port).request({ url: `http://127.0.0.1:${server.port}/` }),
    );

    expect(error.code).toBe('HTTP_NETWORK');
    expect(error.retryable).toBe(true);
  });
});

describe('response size limit', () => {
  it('cuts bodies above the limit and flags them as truncated', async () => {
    const big = 'a'.repeat(3 * 1024 * 1024);
    const server = await startServer((_req, res) => res.end(big));

    const response = await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/`,
    });

    expect(response.status).toBe(200);
    expect(response.truncated).toBe(true);
    expect(Buffer.byteLength(response.body)).toBe(1024 * 1024);
  });

  it('honours a custom limit and reports the boundary exactly', async () => {
    const server = await startServer((request, res) => {
      res.end('x'.repeat(request.url === '/exact' ? 10 : 11));
    });
    const client = localClient(server.port, { maxResponseBytes: 10 });

    const exact = await client.request({ url: `http://127.0.0.1:${server.port}/exact` });
    const over = await client.request({ url: `http://127.0.0.1:${server.port}/over` });

    expect(exact.truncated).toBe(false);
    expect(exact.body).toHaveLength(10);
    expect(over.truncated).toBe(true);
    expect(over.body).toHaveLength(10);
  });

  it('does not keep downloading after the limit is hit', async () => {
    let sentAll = false;
    const server = await startServer((_req, res) => {
      const chunk = 'a'.repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 200) {
          sent++;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        sentAll = true;
        res.end();
      };
      pump();
    });

    const response = await localClient(server.port, { maxResponseBytes: 100 * 1024 }).request({
      url: `http://127.0.0.1:${server.port}/`,
    });

    expect(response.truncated).toBe(true);
    expect(sentAll).toBe(false);
  });

  it('returns small bodies untouched', async () => {
    const server = await startServer((_req, res) => res.end('small'));
    const response = await localClient(server.port).request({
      url: `http://127.0.0.1:${server.port}/`,
    });
    expect(response.body).toBe('small');
    expect(response.truncated).toBe(false);
  });
});
