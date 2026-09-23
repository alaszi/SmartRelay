import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Dev-only: mirrors production's Nginx same-origin routing (MASTER_PLAN section 3) so browser
// fetches to /api/* stay same-origin (cookies, CSRF Origin check) without a dev proxy server.
const apiPort = process.env['API_PORT'] ?? '3001';

const nextConfig: NextConfig = {
  // A minimal, self-contained production server (apps/web/Dockerfile copies just this folder).
  output: 'standalone',
  // This app imports workspace packages (@smartrelay/engine/browser) that live outside apps/web,
  // so the build's file trace needs to start at the monorepo root, not this package's own
  // directory, or the standalone output would be missing those files.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  async rewrites() {
    // In production, Nginx (deploy/nginx.smartrelay.conf) routes /api/* straight to the api
    // container and this rewrite never runs — it only matters for `next dev`, where nothing else
    // fronts the web server.
    return [{ source: '/api/:path*', destination: `http://localhost:${apiPort}/api/:path*` }];
  },
};

export default createNextIntlPlugin('./i18n/request.ts')(nextConfig);
