import { defineConfig } from 'vitest/config';

// Root-level vitest projects: only for code that lives outside the workspace packages
// (the packages run their own vitest through turbo).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'scripts',
          include: ['scripts/**/*.spec.ts'],
        },
      },
    ],
  },
});
