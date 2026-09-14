import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // tsconfig sets `jsx: "preserve"` for Next.js, which leaves JSX in the
  // output and makes Vite refuse any .tsx a test imports (see
  // vitest.config.ts). Needed here too now that an integration test renders
  // a component (IncomeStatementBlock) to prove the grid foots.
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    // tests/integration/controls/* take real row and table locks on one shared database, so two
    // files running at once deadlock each other. The failures shift between files from run to
    // run, which reads as flakiness and has been misdiagnosed as load before. `bun run
    // test:integration` is the command CI would use the moment DATABASE_URL is set, so the safe
    // behaviour belongs here rather than in a flag every caller has to remember.
    //
    // For speed, shard across SEPARATE fixtures instead — they are one command each and
    // independent, so there is nothing to contend on:
    //   bash scripts/forensic/fixture-up.sh 3315<n>   # once per shard
    //   vitest run --config vitest.integration.config.ts --shard=<n>/4
    fileParallelism: false,
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
