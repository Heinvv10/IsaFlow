/**
 * K-081 — migration 659 run twice, across tenants, and after a close.
 *
 * Split out of k081-loan-reclass-backfill.int.test.ts, which covers how a
 * single tenant's history is resolved. What is proven here is what happens on
 * the SECOND run: the rebuild owns only its own ('backfill') rows, never leaks
 * a figure into another tenant, and rebuilds the durable refusal record so it
 * can never disagree with the rows that were (not) reconstructed.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  REBUILD, harness, recorded, refusals, seedCompany, seedLoan, seedReclassJournal, seedScheduleRow,
} from './k081-loan-reclass.helpers';

assertDisposable();
const h = harness();
const journal = seedReclassJournal;

beforeAll(h.setUp);
afterAll(h.tearDown);

it('writes nothing under another tenant and reconstructs each independently', async () => {
  await h.inRollback(async (c) => {
    const one = await seedCompany(c, 'T1');
    const two = await seedCompany(c, 'T2');
    const loanOne = await seedLoan(c, one, 'SHARED-REF');
    const loanTwo = await seedLoan(c, two, 'SHARED-REF');
    await journal(c, one, h.user, 'SHARED-REF', '202602', 100_000);
    await journal(c, two, h.user, 'SHARED-REF', '202602', 55_000);
    await seedScheduleRow(c, one, loanOne, '202602', 100_000);
    await seedScheduleRow(c, two, loanTwo, '202602', 55_000);

    await c.query(REBUILD);

    // The same reference in two companies is not ambiguous — resolution is
    // per company — and neither figure leaks into the other.
    expect(await recorded(c, one.company))
      .toEqual([{ loan_id: loanOne, yyyymm: '202602', st: 100_000 }]);
    expect(await recorded(c, two.company))
      .toEqual([{ loan_id: loanTwo, yyyymm: '202602', st: 55_000 }]);
  });
});

it('is idempotent: a second run reproduces the same rows', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'IDEM');
    const loan = await seedLoan(c, ctx, 'LN-IDEM');
    await journal(c, ctx, h.user, 'LN-IDEM', '202602', 100_000);
    await journal(c, ctx, h.user, 'LN-IDEM', '202603', -8_000);
    await seedScheduleRow(c, ctx, loan, '202602', 100_000);
    await seedScheduleRow(c, ctx, loan, '202603', 92_000);

    await c.query(REBUILD);
    const first = await recorded(c, ctx.company);
    await c.query(REBUILD);

    expect(first).toEqual([
      { loan_id: loan, yyyymm: '202602', st: 100_000 },
      { loan_id: loan, yyyymm: '202603', st: 92_000 },
    ]);
    expect(await recorded(c, ctx.company)).toEqual(first);
  });
});

it('leaves a row the application wrote alone, and re-runs after a close (M1/M5)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'GUARD');
    const loan = await seedLoan(c, ctx, 'LN-GUARD');
    await journal(c, ctx, h.user, 'LN-GUARD', '202602', 100_000);
    await seedScheduleRow(c, ctx, loan, '202602', 100_000);

    // A close has run since the backfill: it wrote both a lock and a row.
    // Round 2 aborted the WHOLE migration here, which made the documented
    // "re-run 659 for that tenant" recovery impossible and abandoned every
    // other tenant's rebuild as well.
    await c.query(
      `INSERT INTO loan_reclass_postings(company_id,loan_id,yyyymm,st_liability,source)
       VALUES($1,$2,'202603',88888,'app')`, [ctx.company, loan]);
    await c.query(
      `INSERT INTO loan_period_locks(company_id,yyyymm,locked_at,locked_by)
       VALUES($1,'202603',now(),$2)`, [ctx.company, h.user]);

    await c.query(REBUILD);

    // The reconstructed month is rebuilt; the application's own row survives
    // untouched at the figure IT recorded, not at anything reconstructed.
    expect(await recorded(c, ctx.company)).toEqual([
      { loan_id: loan, yyyymm: '202602', st: 100_000 },
      { loan_id: loan, yyyymm: '202603', st: 88_888 },
    ]);
    const { rows } = await c.query(
      `SELECT yyyymm, source FROM loan_reclass_postings WHERE company_id=$1 ORDER BY yyyymm`,
      [ctx.company]);
    expect(rows).toEqual([
      { yyyymm: '202602', source: 'backfill' },
      { yyyymm: '202603', source: 'app' },
    ]);
  });
});

it('records every refusal in a table, not only in a WARNING the runner drops (H1)', async () => {
  await h.inRollback(async (c) => {
    const ctx = await seedCompany(c, 'DURABLE');
    await seedLoan(c, ctx, 'LN-DUP');
    await seedLoan(c, ctx, 'LN-DUP');
    await journal(c, ctx, h.user, 'LN-DUP', '202602', 100_000);
    await journal(c, ctx, h.user, 'LN-GONE', '202602', 40_000);

    await c.query(REBUILD);

    expect(await recorded(c, ctx.company)).toEqual([]);
    expect(await refusals(c, ctx.company)).toEqual([
      { loan_key: 'LN-GONE', yyyymm: '202602', reason: 'no loan carries this reference' },
      { loan_key: 'LN-DUP', yyyymm: '202602', reason: 'reference is shared by 2 loans' },
    ]);
  });
});
