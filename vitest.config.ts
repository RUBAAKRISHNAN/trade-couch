import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: 'packages/shared', environment: 'node' } },
      {
        test: {
          name: 'worker',
          root: 'apps/worker',
          environment: 'node',
          include: ['test/market.test.ts', 'test/market-maker.test.ts'],
        },
      },
      { test: { name: 'engine', root: 'apps/engine', environment: 'node', testTimeout: 120_000 } },
      {
        // integration tests share one Postgres test database → run files one at a time
        test: {
          name: 'api',
          root: 'apps/api',
          environment: 'node',
          setupFiles: ['test/setup.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
