/**
 * K-081 review round 2 — migration 659's backfill, executed verbatim.
 *
 * The backfill seeds the `prior` every subsequent reclass journal is computed
 * from, once, on every tenant. Migration 645's version identified a loan by
 * rebuilding its narrative string and matching the line on the loan's CURRENT
 * current-portion account, and neither half of that key is unique: two loans
 * sharing a `reference` each absorbed the other's journals (H1), and two
 * reclass journals in one month collapsed to whichever the window function
 * happened to order first (M3). Both defects end the same way — closeLoanPeriod
 * reads the wrong prior and posts a fabricated movement to the general ledger.
 *
 * Since round 6 a reconstructed figure is also confirmed against the loan's own
 * schedule before it is recorded, so every loan expected to reconstruct here
 * carries the schedule row the close read.
 *
 * Every assertion below runs the `DO` block out of the migration file itself,
 * inside a transaction that is rolled back. Re-run and cross-tenant behaviour
 * lives in k081-loan-reclass-backfill-rerun.int.test.ts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  REBUILD, account, glNet, harness, recorded, refusals, seedCompany, seedLoan,
  seedReclassJournal, seedScheduleRow,
} from './k081-loan-reclass.helpers';

assertDisposable();
const h = harness();
const journal = seedReclassJournal;

beforeAll(h.setUp);
afterAll(h.tearDown);

it('refuses two loans that share a reference instead of giving each the other history (H1)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'H1');
    const a = await seedLoan(c, ctx, 'LN-1');
    const b = await seedLoan(c, ctx, 'LN-1');
    // ONE journal, posted for A only. 645 wrote 202602 = 100 000 for BOTH.
    await journal(c, ctx, h.user, 'LN-1', '202602', 100_000);
    await seedScheduleRow(c, ctx, a, '202602', 100_000);

    await c.query(REBUILD);

    // Neither loan gets a fabricated prior: the key is ambiguous, so it is
    // refused. Their next close reclassifies the full current portion — an
    // overstatement a human can see, not a movement nobody can trace.
    expect(await recorded(c, ctx.company)).toEqual([]);
    expect([a, b]).toHaveLength(2);
  });
});

it('reconstructs an unambiguous loan alongside the refused pair', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'MIX');
    await seedLoan(c, ctx, 'DUP');
    await seedLoan(c, ctx, 'DUP');
    const clean = await seedLoan(c, ctx, 'LN-CLEAN');
    await journal(c, ctx, h.user, 'DUP', '202602', 100_000);
    await journal(c, ctx, h.user, 'LN-CLEAN', '202602', 70_000);
    await journal(c, ctx, h.user, 'LN-CLEAN', '202603', -8_000);
    await seedScheduleRow(c, ctx, clean, '202602', 70_000);
    await seedScheduleRow(c, ctx, clean, '202603', 62_000);

    await c.query(REBUILD);

    // Running balance, so March records the compounded 62 000, not -8 000.
    expect(await recorded(c, ctx.company)).toEqual([
      { loan_id: clean, yyyymm: '202602', st: 70_000 },
      { loan_id: clean, yyyymm: '202603', st: 62_000 },
    ]);
  });
});

it('sums two reclass journals in the same month instead of keeping one (M3)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'M3');
    const loan = await seedLoan(c, ctx, 'LN-M3');
    await journal(c, ctx, h.user, 'LN-M3', '202602', 100_000);
    await journal(c, ctx, h.user, 'LN-M3', '202602', 92_000);
    await seedScheduleRow(c, ctx, loan, '202602', 192_000);

    await c.query(REBUILD);

    // The GL holds 192 000 on the current-portion account; 645 recorded 92 000
    // and stranded the other 100 000 forever.
    expect(await glNet(c, ctx.company, ctx.cp)).toBeCloseTo(192_000, 2);
    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: loan, yyyymm: '202602', st: 192_000 }]);
  });
});

it('refuses a loan whose current-portion account was re-pointed after a close (L3)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'L3');
    const loan = await seedLoan(c, ctx, 'LN-L3');
    const old = await account(c, ctx.company, '2411', 'payable');
    // The close posted against the OLD account; the loan now points elsewhere.
    await journal(c, ctx, h.user, 'LN-L3', '202602', 100_000, { cpAccount: old });
    await seedScheduleRow(c, ctx, loan, '202602', 100_000);

    await c.query(REBUILD);

    expect(await recorded(c, ctx.company)).toEqual([]);
    expect((await refusals(c, ctx.company)).map((r) => r.reason))
      .toEqual(['current-portion account was re-pointed after the close']);
  });
});

it('ignores a reversed reclass entry (L4)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'L4');
    const loan = await seedLoan(c, ctx, 'LN-L4');
    await journal(c, ctx, h.user, 'LN-L4', '202602', 100_000);
    await journal(c, ctx, h.user, 'LN-L4', '202603', 40_000, { reversed: true });
    await seedScheduleRow(c, ctx, loan, '202602', 100_000);

    await c.query(REBUILD);

    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: loan, yyyymm: '202602', st: 100_000 }]);
  });
});

it('reconstructs a loan whose reference is the empty string (M3 regression)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'EMPTY');
    const loan = await seedLoan(c, ctx, '');
    // 'Reclassification – loan  for 202602' is exactly 35 characters; round 2
    // required > 35 and dropped it, silently, where 645 had matched it.
    await journal(c, ctx, h.user, '', '202602', 61_000);
    await seedScheduleRow(c, ctx, loan, '202602', 61_000);

    await c.query(REBUILD);

    expect(await recorded(c, ctx.company))
      .toEqual([{ loan_id: loan, yyyymm: '202602', st: 61_000 }]);
    expect(await refusals(c, ctx.company)).toEqual([]);
  });
});

it('names a description it cannot parse instead of dropping it silently (M3)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'PARSE');
    await seedLoan(c, ctx, 'LN-HYPH');
    // A hyphen where closeLoanPeriod writes an en dash, and a description a
    // user appended to. Round 2 gave each no row AND no warning — the loan
    // then reclassified its full current portion invisibly.
    for (const description of [
      'Reclassification - loan LN-HYPH for 202602',
      'Reclassification – loan LN-HYPH for 202602 (corrected)',
    ]) {
      const entry = randomUUID();
      await c.query(
        `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,
           source,created_by) VALUES($1,$2,$3,'2026-02-28',$4,'posted','manual',$5)`,
        [entry, ctx.company, `JE-${entry.slice(0, 8)}`, description, h.user]);
    }

    await c.query(REBUILD);

    expect(await recorded(c, ctx.company)).toEqual([]);
    expect(await refusals(c, ctx.company)).toEqual([
      { loan_key: null, yyyymm: null,
        reason: 'description does not parse into a loan key and period' },
      { loan_key: null, yyyymm: null,
        reason: 'description does not parse into a loan key and period' },
    ]);
  });
});
