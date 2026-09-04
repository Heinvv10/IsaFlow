/**
 * The advisory lock that stops two reclassification batches moving the same
 * lines twice.
 *
 * THE RACE IT CLOSES. Two requests with DIFFERENT idempotency keys — two agent
 * sessions, or one agent retrying under a fresh key after a timeout — are not
 * serialised by the registry's idempotency lock, which keys on
 * (company, tool, idempotency_key). Both read the candidate lines, both see
 * `already_reclassified = false` because neither has committed its batch rows,
 * and both post. R11,318,214.27 moves twice.
 *
 * DB-gated because a lock is not a shape. A mocked `sql` template would happily
 * "acquire" a lock that Postgres never took, which is the failure this whole
 * class of test exists to catch. Two REAL connections contend here.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import {
  lockReclassSource,
  ReclassSourceLockedError,
} from '@/modules/accounting/services/gl/reclassification/sourceLock';

type Ctx = Parameters<typeof als.run>[0];
const COMPANY = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

function ctxFor(client: PoolClient): Ctx {
  return { client, userId: 'u', companyId: COMPANY, claims: {} } as unknown as Ctx;
}

describe('lockReclassSource (real DB)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('a second batch on the same source BLOCKS until the first commits', async () => {
    assertNotProductionDb('This test takes advisory locks.');
    const a = await getPoolForTests().connect();
    const b = await getPoolForTests().connect();
    try {
      await a.query('BEGIN');
      await als.run(ctxFor(a), () => lockReclassSource(COMPANY, ACCOUNT_A));

      // B wants the same account. Its lock_timeout is 10s, so shorten it here
      // to keep the test fast — the point is that it CANNOT proceed, not how
      // long it waits.
      await b.query('BEGIN');
      await expect(
        als.run(ctxFor(b), () => lockReclassSource(COMPANY, ACCOUNT_A, '250ms')),
      ).rejects.toBeInstanceOf(ReclassSourceLockedError);
      await b.query('ROLLBACK');

      // Once A commits, the lock is gone — transaction-scoped, no unlock path
      // to forget.
      await a.query('COMMIT');
      await b.query('BEGIN');
      await als.run(ctxFor(b), () => lockReclassSource(COMPANY, ACCOUNT_A, '2s'));
      await b.query('ROLLBACK');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('does NOT block a batch on a different source account', async () => {
    // Only the source is locked. Locking the target too would let A→B and B→A
    // deadlock, and two batches with different sources cannot move the same
    // line, so there is nothing to protect.
    assertNotProductionDb('This test takes advisory locks.');
    const a = await getPoolForTests().connect();
    const b = await getPoolForTests().connect();
    try {
      await a.query('BEGIN');
      await als.run(ctxFor(a), () => lockReclassSource(COMPANY, ACCOUNT_A));

      await b.query('BEGIN');
      await als.run(ctxFor(b), () => lockReclassSource(COMPANY, ACCOUNT_B, '2s'));
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('raises a RETRYABLE typed error, not a generic failure', async () => {
    // Nothing has been written when this fires — the lock is taken before the
    // candidates are even read — so the MCP layer answers it as a pre-write
    // toolError and the idempotency key stays free for the retry the message
    // asks for. A generic failure would tell the agent nothing.
    assertNotProductionDb('This test takes advisory locks.');
    const a = await getPoolForTests().connect();
    const b = await getPoolForTests().connect();
    try {
      await a.query('BEGIN');
      await als.run(ctxFor(a), () => lockReclassSource(COMPANY, ACCOUNT_A));

      await b.query('BEGIN');
      // 250ms rather than the production 10s, so the timeout path is asserted
      // deterministically instead of the test accepting whichever of two errors
      // happened to arrive first.
      await expect(
        als.run(ctxFor(b), () => lockReclassSource(COMPANY, ACCOUNT_A, '250ms')),
      ).rejects.toBeInstanceOf(ReclassSourceLockedError);
      await b.query('ROLLBACK');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('REFUSES to run outside a request transaction', async () => {
    // Outside one, pg_advisory_xact_lock releases the instant the statement
    // returns and the caller believes it is serialised when it is not. A loud
    // failure beats a lock that silently does nothing.
    await expect(lockReclassSource(COMPANY, ACCOUNT_A)).rejects.toThrow(/request transaction/);
  });
});
