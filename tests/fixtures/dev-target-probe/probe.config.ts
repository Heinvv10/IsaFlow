// Fixture of tests/unit/e2e/devTargetRunner.test.ts: no global setup, so only the spec's own guard stands.
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'probe.pw.ts',
  outputDir: path.join(os.tmpdir(), `dev-target-probe-${process.pid}`),
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.PROBE_BASE_URL },
});
