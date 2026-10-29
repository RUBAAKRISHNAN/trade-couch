import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: 'packages/shared', environment: 'node' } },
      { test: { name: 'engine', root: 'apps/engine', environment: 'node', testTimeout: 120_000 } },
      {
        // integration tests share one Postgres test database → run files one at a time
        test: {
          name: 'api',
          root: 'apps/api',
          environment: 'node',
          setupFiles: ['test/setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
