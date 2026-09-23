import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// Overridable only so this same config can run against a non-default port locally (e.g. when
// something else on the machine already holds 3000/3001); the committed defaults match
// .env.example and every other dev-server reference in the repo.
const webPort = process.env['PLAYWRIGHT_WEB_PORT'] ?? '3000';
const apiPort = process.env['PLAYWRIGHT_API_PORT'] ?? '3001';
const baseURL = `http://localhost:${webPort}`;

/**
 * Phase 4's "done when" bar (MASTER_PLAN section 14): a Playwright smoke test covering relay
 * creation for Module 1. Assumes the dev stack's Postgres/Redis/Mailpit
 * (`docker compose up -d`) and a migrated + seeded database are already running — this only
 * starts the api and web dev servers themselves.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'pnpm --filter @smartrelay/api dev',
      cwd: repoRoot,
      url: `http://localhost:${apiPort}/healthz`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'pnpm dev',
      cwd: __dirname,
      url: baseURL,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: { PORT: webPort },
    },
  ],
});
