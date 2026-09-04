import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode ?? 'test', process.cwd(), '');
  return {
    // tsconfig sets `jsx: "preserve"` for Next.js, which leaves JSX in the
    // output and makes Vite refuse any .tsx a test imports. Without this a
    // rendered component cannot be unit-tested at all — which is why deleting a
    // whole section from the AFS statement left the full suite green.
    plugins: [react()],
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
      testTimeout: 10000,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        thresholds: {
          lines: 60,
          functions: 60,
          branches: 50,
          statements: 60,
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
