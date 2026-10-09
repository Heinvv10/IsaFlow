import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAX_DEV_APPLY, APPLY_STATEMENT_TIMEOUT_MS, ADVISORY_LOCK_KEY } from '../../../scripts/lib/migrationParityRun';

// Pinned on purpose: changing any of these loosens a deploy-time safety limit and should be a deliberate, reviewed edit.
describe('parity gate limits', () => {
  it('caps --apply-dev at 10 files', () => expect(MAX_DEV_APPLY).toBe(10));
  it('bounds one applied migration at 15 minutes', () => expect(APPLY_STATEMENT_TIMEOUT_MS).toBe(900_000));
  it('uses the runner advisory lock key', () => expect(ADVISORY_LOCK_KEY).toBe(73014132));
});

// TEXT check, not behaviour: the integration suite needs a database, so this only pins the ORDER of two lines in its
// beforeAll - the server-side throwaway check must run before the cluster is recorded for cleanup (and for DDL).
describe('integration suite beforeAll ordering (text check)', () => {
  const src = readFileSync(join(process.cwd(), 'tests', 'integration', 'migration-parity-gate.int.test.ts'), 'utf8');
  const guard = src.indexOf('assertOnlyThrowawayDatabases((await');
  const push = src.indexOf('clusters.push(base)');
  const firstDdl = src.indexOf('DROP DATABASE IF EXISTS ${db} WITH (FORCE)');
  it('checks the server before recording the cluster and before any DROP/CREATE', () => {
    expect(guard).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(guard);
    expect(firstDdl).toBeGreaterThan(guard);
  });
});
