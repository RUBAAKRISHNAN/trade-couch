import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: 'packages/shared', environment: 'node' } },
      {
        resolve: { alias: { '@': path.resolve(import.meta.dirname, 'apps/web/src') } },
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'web',
          root: 'apps/web',
          environment: 'jsdom',
          setupFiles: ['src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
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
