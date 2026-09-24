/**
 * Unlocking a filed VAT period, re-locking it, and the advisory lock that stops
 * a post interleaving with a lock's figure snapshot.
 *
 * An unlock is history, not a delete: the row keeps the figures that were
 * filed and gains who unlocked it, when and why. Only an ACTIVE row
 * (unlocked_at IS NULL) locks anything, and the partial unique index lets the
 * same period be locked again afterwards.
 *
 * Concurrency: every post takes pg_advisory_xact_lock_SHARED on a per-company
 * key, and lock/unlock/the figure snapshot take the EXCLUSIVE lock on the same
 * key. Proven here by outcome — a statement that needs the conflicting mode
 * times out on lock_timeout (55P03) while the other transaction holds it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import {
  VatPeriodUnlockRefusal, getVatPeriodLock, isVatPeriodLocked, listVatPeriodLocks, lockVatPeriod, unlockVatPeriod,
} from '@/modules/accounting/services/reports/vatPeriodLockService';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import { assertJournalVatPeriodOpen } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, runOn, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
const FIG = { outputTax: 150, inputTax: 45, netVat: 105, postedThrough: '2026-04-30T10:00:00.000Z' };
const actor = () => ({ userId: fx.userId, actorType: 'human' as const });

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(VatPeriodUnlockRefusal);
  return (err as Error).message;
}

/** Hold a transaction open on its own connection while `probe` runs on another. */
async function whileHeld(
  hold: () => Promise<unknown>, probe: () => Promise<unknown>,
): Promise<unknown> {
  const a: PoolClient = await fx.pool.connect();
  const b: PoolClient = await fx.pool.connect();
  try {
    await a.query('BEGIN');
    await runOn(fx, a, hold);
    await b.query('BEGIN');
    await b.query(`SET LOCAL lock_timeout = '400ms'`);
    return await runOn(fx, b, probe).then(() => 'ran', (e: unknown) => (e as { code?: string }).code ?? e);
  } finally {
    await b.query('ROLLBACK').catch(() => undefined);
    await a.query('ROLLBACK').catch(() => undefined);
    a.release();
    b.release();
  }
}

const VAT_LINE = [{ glAccountId: '00000000-0000-4000-8000-000000000001', vatType: 'standard' }];

describeIfDb('VAT period unlock, re-lock and the advisory lock', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test writes VAT period locks.');
    fx = await seedFixture('VLU', DATABASE_URL!);
    other = await seedFixture('VLX', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
    }
  }, 120000);

  it('unlocks with a reason, keeps the row as history, and lets the period be locked again', async () => {
    const first = await inTx(fx, () => lockVatPeriod(fx.companyId, '2026-03-01', '2026-04-30', FIG, actor(), 'eFiling 1'));
    expect(first.created).toBe(true);
    expect(await isVatPeriodLocked(fx.companyId, '2026-03-15')).toBe(true);

    const unlocked = await inTx(fx, () => unlockVatPeriod(fx.companyId, first.lock.id, fx.userId, 'Amending the March return'));
    expect(unlocked).toMatchObject({ id: first.lock.id, active: false, unlockedBy: fx.userId, unlockReason: 'Amending the March return' });
    expect(unlocked.unlockedAt).not.toBeNull();
    expect(await isVatPeriodLocked(fx.companyId, '2026-03-15')).toBe(false);
    expect(await getVatPeriodLock(fx.companyId, '2026-03-01', '2026-04-30')).toBeNull();

    const again = await inTx(fx, () => lockVatPeriod(fx.companyId, '2026-03-01', '2026-04-30', { ...FIG, outputTax: 160 }, actor()));
    expect(again.created).toBe(true);
    expect(again.lock.id).not.toBe(first.lock.id);
    expect(await isVatPeriodLocked(fx.companyId, '2026-03-15')).toBe(true);

    const all = (await listVatPeriodLocks(fx.companyId)).filter((l) => l.periodStart === '2026-03-01');
    expect(all.map((l) => [l.id, l.active, l.outputTax])).toEqual(expect.arrayContaining([
      [first.lock.id, false, 150], [again.lock.id, true, 160],
    ]));
    // A second lock of the ACTIVE period is still idempotent, not a third row.
    const dup = await inTx(fx, () => lockVatPeriod(fx.companyId, '2026-03-01', '2026-04-30', FIG, actor()));
    expect(dup).toMatchObject({ created: false, lock: { id: again.lock.id } });
  });

  it('refuses a blank reason, an unknown or foreign lock, and an already-unlocked one', async () => {
    const { lock } = await inTx(fx, () => lockVatPeriod(fx.companyId, '2026-01-01', '2026-02-28', FIG, actor()));
    expect(await refusal(inTx(fx, () => unlockVatPeriod(fx.companyId, lock.id, fx.userId, '   ')))).toMatch(/reason/i);
    const foreign = await inTx(other, () => lockVatPeriod(other.companyId, '2026-01-01', '2026-02-28', FIG,
      { userId: other.userId, actorType: 'human' }));
    expect(await refusal(inTx(fx, () => unlockVatPeriod(fx.companyId, foreign.lock.id, fx.userId, 'x')))).toMatch(/not found/i);
    expect(await refusal(inTx(fx, () => unlockVatPeriod(fx.companyId, '00000000-0000-4000-8000-00000000abcd', fx.userId, 'x'))))
      .toMatch(/not found/i);
    await inTx(fx, () => unlockVatPeriod(fx.companyId, lock.id, fx.userId, 'amend'));
    expect(await refusal(inTx(fx, () => unlockVatPeriod(fx.companyId, lock.id, fx.userId, 'again')))).toMatch(/already unlocked/i);
    expect(await isVatPeriodLocked(other.companyId, '2026-01-15')).toBe(true);
  });

  it('the table itself refuses a half-stamped unlock', async () => {
    const { lock } = await inTx(fx, () => lockVatPeriod(fx.companyId, '2025-09-01', '2025-10-31', FIG, actor()));
    const err = await sql`UPDATE vat_period_locks SET unlocked_at = NOW() WHERE id = ${lock.id}::UUID`
      .then(() => null, (e: unknown) => e as { code?: string });
    expect(err?.code).toBe('23514');
    const blank = await sql`
      UPDATE vat_period_locks SET unlocked_at = NOW(), unlocked_by = 'u', unlock_reason = '  ' WHERE id = ${lock.id}::UUID`
      .then(() => null, (e: unknown) => e as { code?: string });
    expect(blank?.code).toBe('23514');
  });

  describe('advisory lock: a post cannot interleave with a lock, an unlock or a figure snapshot', () => {
    it('a post waits while lockVatPeriod holds the exclusive key', async () => {
      expect(await whileHeld(
        () => lockVatPeriod(fx.companyId, '2025-11-01', '2025-12-31', FIG, actor()),
        () => assertJournalVatPeriodOpen(fx.companyId, '2026-06-01', VAT_LINE),
      )).toBe('55P03');
    });

    it('a post waits while the figure snapshot holds the exclusive key', async () => {
      expect(await whileHeld(
        () => computeVatLockFigures(fx.companyId, '2025-11-01', '2025-12-31'),
        () => assertJournalVatPeriodOpen(fx.companyId, '2026-06-01', VAT_LINE),
      )).toBe('55P03');
    });

    // The exclusive side sets its own 5s lock_timeout (vat-period-lock-bounds
    // pins the timing), so it refuses with the typed code, not a bare 55P03.
    it('lock and unlock wait while a post holds the shared key', async () => {
      expect(await whileHeld(
        () => assertJournalVatPeriodOpen(fx.companyId, '2026-06-01', VAT_LINE),
        () => lockVatPeriod(fx.companyId, '2025-11-01', '2025-12-31', FIG, actor()),
      )).toBe('VAT_LOCK_TIMEOUT');
      const { lock } = await inTx(fx, () => lockVatPeriod(fx.companyId, '2026-07-01', '2026-08-31', FIG, actor()));
      expect(await whileHeld(
        () => assertJournalVatPeriodOpen(fx.companyId, '2026-06-01', VAT_LINE),
        () => unlockVatPeriod(fx.companyId, lock.id, fx.userId, 'amend'),
      )).toBe('VAT_LOCK_TIMEOUT');
    }, 30000);

    it('two posts do not block each other, and another company is not blocked', async () => {
      expect(await whileHeld(
        () => assertJournalVatPeriodOpen(fx.companyId, '2026-06-01', VAT_LINE),
        () => assertJournalVatPeriodOpen(fx.companyId, '2026-06-01', VAT_LINE),
      )).toBe('ran');
      expect(await whileHeld(
        () => lockVatPeriod(fx.companyId, '2025-11-01', '2025-12-31', FIG, actor()),
        () => sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${other.companyId}::text, 570))`,
      )).toBe('ran');
    });
  });
});
