/**
 * Item 6: the override record and the lock/submission write must be atomic.
 *
 * assertVatGateClear WRITES the override row (migration 704) before its
 * caller attempts the actual lock/submission write. If that write then fails,
 * the override previously stood for an action that never happened. The
 * routes/MCP tool now wrap both in ONE savepoint (`withSavepoint`) — this
 * pins the pattern directly: a failing `lockVatPeriod` (assertLockablePeriod
 * refuses a period ending after today) inside the SAME savepoint as
 * `assertVatGateClear` must leave NO override row behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, withSavepoint } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { assertVatGateClear, VatGateBlockedError } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { lockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
import { VatPeriodLockRefusal } from '@/modules/accounting/services/reports/vatPeriodLockBounds';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import type { GLEntrySource, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;

// Far enough in the future that assertLockablePeriod's "ends after today"
// refusal fires deterministically regardless of when this test runs.
const FUTURE = { start: '2099-01-01', end: '2099-02-28' } as const;

async function post(date: string, source: GLEntrySource, lines: JournalLineInput[]) {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: date, description: `r-vatgaps-6 ${source}`, source, lines,
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}

const overrideCount = () => sql`
  SELECT COUNT(*)::INT AS n FROM vat_gate_overrides
  WHERE company_id = ${fx.companyId}::UUID AND target_type = 'vat_period_lock'
` as Promise<Row[]>;

describeIfDb('VAT gate override + lock write are atomic (item 6)', () => {
  beforeAll(async () => {
    assertNotProductionDb('r-vatgaps-6');
    fx = await seedLateFixture('RVG6', DATABASE_URL!);
    // An uncoded VAT-input GL line in the FUTURE period, so the gate has a
    // blocking exception to override. (A bare unsupported input-VAT claim no
    // longer blocks — Hein, 2026-09-26 — so this test needs a still-blocking
    // category instead.)
    await post(FUTURE.start, 'manual', [
      { glAccountId: fx.vatInputId, debit: 200, credit: 0, description: 'uncoded' },
      { glAccountId: fx.expenseId, debit: 0, credit: 200, description: 'uncoded' },
    ]);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM vat_gate_overrides WHERE company_id = ${fx.companyId}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  it('a lock write that fails inside the same savepoint as the override leaves NO override row', async () => {
    const before = Number((await overrideCount())[0]!.n);

    const { figures } = await inTx(fx, () => computeVatLockFigures(fx.companyId, FUTURE.start, FUTURE.end));

    const attempt = () => inTx(fx, () => withSavepoint('r_vatgaps_6', async () => {
      await assertVatGateClear(
        fx.companyId, FUTURE.start, FUTURE.end, 'vat_period_lock', null,
        { userId: fx.userId, role: 'owner' }, 'testing atomicity',
      );
      // This throws VatPeriodLockRefusal (period ends after today) — the
      // savepoint must roll back the override INSERT above along with it.
      return lockVatPeriod(fx.companyId, FUTURE.start, FUTURE.end, figures, { userId: fx.userId, actorType: 'human' });
    }));

    await expect(attempt()).rejects.toThrow(VatPeriodLockRefusal);

    const after = Number((await overrideCount())[0]!.n);
    expect(after).toBe(before);
  });

  it('control: WITHOUT the savepoint wrapper, the same sequence would leave a phantom override (documents the bug this fixes)', async () => {
    const before = Number((await overrideCount())[0]!.n);

    const { figures } = await inTx(fx, () => computeVatLockFigures(fx.companyId, FUTURE.start, FUTURE.end));

    // Same two calls, but NOT wrapped in a shared savepoint/transaction —
    // each runs in its own committed connection, exactly as the pre-fix
    // route did (gate call, then a separate lockVatPeriod call).
    await assertVatGateClear(
      fx.companyId, FUTURE.start, FUTURE.end, 'vat_period_lock', null,
      { userId: fx.userId, role: 'owner' }, 'testing atomicity (unwrapped)',
    );
    await expect(
      lockVatPeriod(fx.companyId, FUTURE.start, FUTURE.end, figures, { userId: fx.userId, actorType: 'human' }),
    ).rejects.toThrow(VatPeriodLockRefusal);

    const after = Number((await overrideCount())[0]!.n);
    // This is the DEFECT the atomic wrapper fixes: an unwrapped sequence
    // leaves the override row standing even though nothing was locked.
    expect(after).toBe(before + 1);
  });

  it('sanity: assertVatGateClear alone still refuses cleanly with no reason, writing nothing', async () => {
    const before = Number((await overrideCount())[0]!.n);
    await expect(
      assertVatGateClear(fx.companyId, FUTURE.start, FUTURE.end, 'vat_period_lock', null, { userId: fx.userId, role: 'owner' }, undefined),
    ).rejects.toBeInstanceOf(VatGateBlockedError);
    const after = Number((await overrideCount())[0]!.n);
    expect(after).toBe(before);
  });
});
