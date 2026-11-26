// Fixture of tests/unit/e2e/devTargetRunner.test.ts: no global setup, so only the spec's own guard stands.
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'probe.pw.ts',
  // The runner test gives a directory it removes afterwards.
  outputDir: process.env.PROBE_OUTPUT_DIR ?? path.join(os.tmpdir(), 'dev-target-probe'),
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.PROBE_BASE_URL },
});
