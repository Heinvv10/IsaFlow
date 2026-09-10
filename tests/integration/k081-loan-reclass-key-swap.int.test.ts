/**
 * K-081 review round 6 — M1 and L1, against migration 659 itself.
 *
 * M1: `loans.reference` is mutable and carries no unique constraint, and
 * `updateLoan` writes `reference = COALESCE(…, reference)`, so two loans can
 * SWAP references and a reference freed by a rename can be REUSED by another
 * loan. Both are ordinary API operations and both leave every reclass journal
 * resolving to exactly ONE loan — the wrong one. No key is ambiguous and no
 * journal is unattributable, so the round-5 taint rules see nothing, and the
 * per-account totals foot identically under either attribution, so no balance
 * check sees anything either. The next close then journals `target − someone
 * else's prior`: a fabricated movement, posted silently. That is the defect the
 * whole migration exists to prevent.
 *
 * The rebuild therefore no longer trusts the key it resolved. Every
 * reconstructed figure is confirmed against the loan's OWN
 * `loan_schedule_rows.st_liability` for that month — the figure `recordReclass`
 * writes — over every run the loan has, and a loan with one period the schedule
 * does not confirm is refused whole.
 *
 * L1: an unattributable journal used to taint every loan whose current-portion
 * account it touched on ANY leg, including as the contra of a foreign reclass.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  REBUILD, account, glNet, harness, recorded, refusals, seedCompany, seedLoan,
  seedReclassJournal, seedScheduleRow,
} from './k081-loan-reclass.helpers';

assertDisposable();
const h = harness();
const journal = seedReclassJournal;

const UNCONFIRMED = 'no schedule run of this loan confirms the reconstructed current portion '
  + 'for one of its periods, so the narrative key may name a different loan';

beforeAll(h.setUp);
afterAll(h.tearDown);

it('refuses both loans when two references were swapped (M1)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'SWAP');
    // X was captured as LN-001 and Y as LN-002; the two were swapped later to
    // correct the capture. Every journal still carries the key of the day.
    const x = await seedLoan(c, ctx, 'LN-002');
    const y = await seedLoan(c, ctx, 'LN-001');
    await journal(c, ctx, h.user, 'LN-001', '202602', 100_000);  // X's
    await journal(c, ctx, h.user, 'LN-001', '202603', 92_000);   // X's
    await journal(c, ctx, h.user, 'LN-002', '202603', 75_000);   // Y's
    // What each loan's close actually reclassified it to.
    await seedScheduleRow(c, ctx, x, '202602', 100_000);
    await seedScheduleRow(c, ctx, x, '202603', 192_000);
    await seedScheduleRow(c, ctx, y, '202603', 75_000);

    await c.query(REBUILD);

    // Resolved by key alone, Y would take X's 192 000 and X would take Y's
    // 75 000 — a 117 000 fabrication at the next close of each, invisible in
    // every total: the account still holds 267 000 either way.
    expect(await glNet(c, ctx.company, ctx.cp)).toBeCloseTo(267_000, 2);
    expect(await recorded(c, ctx.company)).toEqual([]);
    const reasons = new Set((await refusals(c, ctx.company)).map((r) => r.reason));
    expect([...reasons]).toEqual([UNCONFIRMED]);
  });
});

it('refuses a loan whose old reference a second loan reused (M1)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'REUSE');
    // A was LN-A when it closed 202602; it was renamed, and a new loan B took
    // the freed reference and closed 202603 under it.
    const a = await seedLoan(c, ctx, 'LN-A2');
    const b = await seedLoan(c, ctx, 'LN-A');
    await journal(c, ctx, h.user, 'LN-A', '202602', 100_000);   // A's
    await journal(c, ctx, h.user, 'LN-A2', '202603', 92_000);   // A's
    await journal(c, ctx, h.user, 'LN-A', '202603', 30_000);    // B's
    await seedScheduleRow(c, ctx, a, '202602', 100_000);
    await seedScheduleRow(c, ctx, a, '202603', 192_000);
    await seedScheduleRow(c, ctx, b, '202603', 30_000);

    await c.query(REBUILD);

    // By key: B = 202602 100 000 → 202603 130 000, A = 202603 92 000. Both
    // wrong, both resolving to exactly one loan, neither one an orphan.
    expect(await recorded(c, ctx.company)).toEqual([]);
    expect((await refusals(c, ctx.company)).map((r) => r.reason))
      .toEqual([UNCONFIRMED, UNCONFIRMED, UNCONFIRMED]);
  });
});

it('still records the loan on that account whose schedule does confirm it', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'MIXED');
    const x = await seedLoan(c, ctx, 'LN-002');
    const y = await seedLoan(c, ctx, 'LN-001');
    const ok = await seedLoan(c, ctx, 'LN-OK');
    await journal(c, ctx, h.user, 'LN-001', '202602', 100_000);
    await journal(c, ctx, h.user, 'LN-002', '202603', 75_000);
    await journal(c, ctx, h.user, 'LN-OK', '202602', 40_000);
    await journal(c, ctx, h.user, 'LN-OK', '202603', 5_000);
    await seedScheduleRow(c, ctx, x, '202602', 100_000);
    await seedScheduleRow(c, ctx, y, '202603', 75_000);
    await seedScheduleRow(c, ctx, ok, '202602', 40_000);
    await seedScheduleRow(c, ctx, ok, '202603', 45_000);

    await c.query(REBUILD);

    // The confirmation is per loan, so a swapped pair does not cost the whole
    // company its backfill the way an unattributable journal does.
    expect(await recorded(c, ctx.company)).toEqual([
      { loan_id: ok, yyyymm: '202602', st: 40_000 },
      { loan_id: ok, yyyymm: '202603', st: 45_000 },
    ]);
  });
});

it('confirms against an older run when a reprice restated the month', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'REPRICE');
    const loan = await seedLoan(c, ctx, 'LN-RP');
    await journal(c, ctx, h.user, 'LN-RP', '202602', 100_000);
    // The run the close read, then a later run that restated the same month.
    await seedScheduleRow(c, ctx, loan, '202602', 100_000);
    await seedScheduleRow(c, ctx, loan, '202602', 111_111);

    await c.query(REBUILD);

    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: loan, yyyymm: '202602', st: 100_000 }]);
  });
});

it('refuses a loan no schedule run covers at all', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'NOSCHED');
    await seedLoan(c, ctx, 'LN-NS');
    await journal(c, ctx, h.user, 'LN-NS', '202602', 100_000);

    await c.query(REBUILD);

    // Nothing corroborates the attribution, so nothing is recorded — the cost
    // of deciding attribution by outcome, and a refusal a human can act on.
    expect(await recorded(c, ctx.company)).toEqual([]);
    expect((await refusals(c, ctx.company)).map((r) => r.reason)).toEqual([UNCONFIRMED]);
  });
});

it('does not refuse a loan an orphan journal touched only as its contra leg (L1)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'CONTRA');
    const other = await account(c, ctx.company, '2412', 'payable');
    const loan = await seedLoan(c, ctx, 'LN-C');
    await journal(c, ctx, h.user, 'LN-C', '202602', 60_000);
    await seedScheduleRow(c, ctx, loan, '202602', 60_000);
    // A journal no loan can be named for, whose DEBIT leg happens to land on
    // this loan's current-portion account and whose credit lands elsewhere.
    // A reclass of THIS loan would have moved its long-term account too.
    await journal(c, ctx, h.user, 'LN-ORPHAN', '202602', 25_000,
      { ltAccount: ctx.cp, cpAccount: other });

    await c.query(REBUILD);

    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: loan, yyyymm: '202602', st: 60_000 }]);
    expect((await refusals(c, ctx.company)).map((r) => r.loan_key)).toEqual(['LN-ORPHAN']);
  });
});

