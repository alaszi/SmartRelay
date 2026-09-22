import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Dev-only: mirrors production's Nginx same-origin routing (MASTER_PLAN section 3) so browser
// fetches to /api/* stay same-origin (cookies, CSRF Origin check) without a dev proxy server.
const apiPort = process.env['API_PORT'] ?? '3001';

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `http://localhost:${apiPort}/api/:path*` }];
  },
};

export default createNextIntlPlugin('./i18n/request.ts')(nextConfig);
