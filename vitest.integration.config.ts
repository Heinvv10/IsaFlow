import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    env: {
      // Fallback DATABASE_URL so tests that don't use the DB can import
      // neon-dependent modules without a real connection string.
      // Tests that need real DB access must have DATABASE_URL in the environment.
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://dummy:dummy@dummy.neon.tech/test',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
