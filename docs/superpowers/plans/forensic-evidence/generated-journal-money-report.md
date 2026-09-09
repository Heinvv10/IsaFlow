# Generated journal monetary binding

The issued parent permit now carries the server-derived exact amount and currency. Generated children must match both before observation, posting or effect receipts. Parent relationship and accounting date alone previously allowed a different nominal amount.

Validation on the local disposable fixture:
- Unit RED: missing monetary guard; GREEN: 38 focused control tests.
- PostgreSQL RED: a related contra for 100 posted against a 115.10 parent (one failed assertion, ten skipped). The guard call was deliberately omitted to reproduce this, then restored.
- PostgreSQL GREEN: `bunx vitest run --config vitest.integration.config.ts tests/integration/controls/glSharedWriters.int.test.ts tests/integration/controls/apSharedWriters.int.test.ts`: 22 passed, two files, 6.90s.
- `bun run type-check`: passed. ESLint on three changed source files: passed. Direct ESLint of the unit test is outside the repository TypeScript project and reports a project-service parsing error; source lint was rerun separately without weakening configuration.

Raw local logs are retained under the sibling `mcp-forensic-artifacts-20260909` directory. Payroll writers and remaining generated financial families still need integrated verification. No production verification occurred.
