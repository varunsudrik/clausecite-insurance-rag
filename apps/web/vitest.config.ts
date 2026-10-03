import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.spec.{ts,tsx}'],
    globals: true,
    // Node >= 25 ships a native `localStorage` accessor (undefined without --localstorage-file) that
    // shadows jsdom's Storage in the test environment; turn it off so jsdom's localStorage is used.
    execArgv: ['--no-experimental-webstorage'],
  },
});
