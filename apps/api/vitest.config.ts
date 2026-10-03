import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.spec.ts'], exclude: ['src/**/*.int.spec.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/**/*.int.spec.ts', 'src/**/*.int.spec.ts'],
          testTimeout: 120_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
