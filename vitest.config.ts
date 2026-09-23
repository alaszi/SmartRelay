import { defineConfig } from 'vitest/config';

const exclude = ['**/node_modules/**', '**/dist/**'];

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/**/*.test.ts'],
          exclude: [...exclude, '**/*.int.test.ts'],
        },
      },
      {
        // Integration tests need the docker-compose services (Postgres, Redis). They share one
        // test database, so files run one at a time.
        test: {
          name: 'integration',
          include: ['{apps,packages}/**/*.int.test.ts'],
          exclude,
          globalSetup: ['./packages/db/test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
