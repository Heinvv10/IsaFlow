import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode ?? 'test', process.cwd(), '');
  return {
    test: {
      globals: true,
      environment: 'node',
      env: {
        // Use the real DATABASE_URL when available (needed for Neon-backed tests).
        // Falls back to the dummy URL so pure-unit tests that don't touch the DB
        // continue to work without a live connection.
        DATABASE_URL: env['DATABASE_URL'] ?? 'postgresql://dummy:dummy@dummy/test',
      },
      include: ['tests/unit/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
