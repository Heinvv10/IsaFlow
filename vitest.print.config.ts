import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// The tests that launch real Chromium — everything under tests/unit/print/ —
// run here, and only here: vitest.config.ts excludes the directory, and
// scripts/ci/run-ci.sh runs this config as the required `browser-tests` step.
// One file at a time, because two browsers on a busy box is what made these
// time out inside the default run.
//
// VELO_MACHINE_FILES need a binary only the `velo` group's job installs
// (ci.yml's Browser & integration apt step; velo itself has them), not the
// static job that runs `unit-tests`. There they would skip (soffice:
// describe.skipIf) or fail (PG16's initdb at /usr/lib/postgresql/16/bin; nginx,
// which fails when GITHUB_ACTIONS is set) instead of testing anything.
export const VELO_MACHINE_FILES = [
  'tests/unit/lib/xlsxNormaliseScanNames.test.ts', // /usr/bin/soffice (LibreOffice)
  'tests/unit/ci/integrationLifecycle.test.ts', // PostgreSQL 16 initdb/pg_ctl
  'tests/unit/scripts/blueGreenNginx.test.ts', // /usr/sbin/nginx
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode ?? 'test', process.cwd(), '');
  return {
    plugins: [react()],
    test: {
      globals: true,
      environment: 'node',
      env: {
        DATABASE_URL: env['DATABASE_URL'] ?? 'postgresql://dummy:dummy@dummy/test',
      },
      include: ['tests/unit/print/**/*.test.ts', ...VELO_MACHINE_FILES],
      fileParallelism: false,
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
    resolve: {
      alias: {
        'next/font/google': path.resolve(__dirname, './tests/stubs/nextFontGoogle.ts'),
        'next/font/local': path.resolve(__dirname, './tests/stubs/nextFontLocal.ts'),
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
