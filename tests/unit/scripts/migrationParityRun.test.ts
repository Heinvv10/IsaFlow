import { describe, it, expect } from 'vitest';
import { MAX_DEV_APPLY, APPLY_STATEMENT_TIMEOUT_MS, ADVISORY_LOCK_KEY } from '../../../scripts/lib/migrationParityRun';

// Pinned on purpose: changing any of these loosens a deploy-time safety limit and should be a deliberate, reviewed edit.
describe('parity gate limits', () => {
  it('caps --apply-dev at 10 files', () => expect(MAX_DEV_APPLY).toBe(10));
  it('bounds one applied migration at 15 minutes', () => expect(APPLY_STATEMENT_TIMEOUT_MS).toBe(900_000));
  it('uses the runner advisory lock key', () => expect(ADVISORY_LOCK_KEY).toBe(73014132));
});
