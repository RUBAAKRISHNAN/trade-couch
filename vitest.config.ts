import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: 'packages/shared', environment: 'node' } },
      { test: { name: 'engine', root: 'apps/engine', environment: 'node', testTimeout: 120_000 } },
    ],
  },
});
