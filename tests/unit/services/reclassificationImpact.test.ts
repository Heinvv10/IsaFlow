/**
 * `computeReclassImpact` against a real Postgres.
 *
 * WHY DB-GATED RATHER THAN MOCKED. The whole substance of this file is one
 * SQL projection — a `proj` CTE that re-groups the same scan with the moved
 * lines re-pointed at the target account — plus a normal-balance sign flip.
 * A mocked `sql` template asserts the shape of a statement and can say nothing
 * about whether the projection projects anything.
 *
 * THE ONE THAT MATTERS. `no_profit_and_loss_effect` is the warning this feature
 * leans on to call a 414-line, R11.3m move harmless. It is computed by
 * comparing the two sides of THIS function. If the projection were a no-op the
 * two sides would be identical on every call, the warning would fire every
 * time, and it would read as reassurance while proving nothing. So the first
 * test below is written to fail when the projection stops projecting.
 *
 * Everything runs inside one transaction that is rolled back.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// The OWNING P&L service is the peer this file's fold is checked against, so
// the one thing the DB alone can never show is a DISAGREEMENT — two correct
// implementations reading the same window always agree. Faking the peer is what
// makes `basisFault` reachable from `computeReclassImpact` itself; without it,
// `const fault = undefined;` passes every test in this file.
const financialFigures = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => {
  const actual = await orig<typeof import(
    '@/modules/accounting/services/gl/financialFiguresService')>();
  return {
    ...actual,
    getFinancialFigures: (...args: Parameters<typeof actual.getFinancialFigures>) =>
      financialFigures.spy.getMockImplementation()
        ? financialFigures.spy(...args)
        : actual.getFinancialFigures(...args),
  };
});

import { getPoolForTests } from '@/lib/neon';
import {
  compareToOwner,
  computeReclassImpact,
} from '@/modules/accounting/services/gl/reclassification/impact';
import type { ClassifiedFigures } from '@/modules/accounting/services/gl/accountClassification';

type Ctx = Parameters<typeof als.run>[0];
const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const AMOUNT = 4321.55;

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

interface Fixture {
  companyId: string;
  today: string;
  /** expense / NULL subtype — defaults into operating expenses. */
  sourceId: string;
  /** expense / cost_of_sales — a DIFFERENT band. */
  costOfSalesId: string;
  /** expense / operating_expense — the SAME band as the source. */
  sameBandId: string;
  lineId: string;
}

async function makeAccount(
  client: PoolClient, companyId: string, suffix: string,
  type: string, normal: string, subtype: string | null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gl_accounts
       (company_id, account_code, account_name, account_type, normal_balance, account_subtype, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
    [companyId, `IMP${suffix}`, `Impact fixture ${suffix}`, type, normal, subtype],
  );
  return rows[0]!.id;
}

/**
 * A COMPANY OF ITS OWN, created inside this test's transaction.
 *
 * `uq_gl_je_company_entry_number` is unique on (company_id, entry_number) and
 * `createJournalEntry` derives the number from that company's existing maximum.
 * Every DB-gated test that borrowed "the first company with an open period" was
 * therefore racing every other one for the next number, and under parallel file
 * execution that surfaces as a 23505 in whichever test lost — a documented flake
 * in this repo which these tests were making MORE likely by posting more
 * journals into the shared company. A private company takes this file out of
 * that contention entirely.
 *
 * Rolled back with everything else, so nothing is left behind.
 */
async function makeCompany(client: PoolClient): Promise<{ companyId: string; today: string }> {
  const { rows: co } = await client.query<{ id: string }>(
    "INSERT INTO companies (name) VALUES ('Reclass fixture co') RETURNING id",
  );
  const companyId = co[0]!.id;
  // One open period covering today, so every journal this file posts resolves a
  // fiscal_period_id and postJournalEntry's open-period check passes.
  await client.query(
    `INSERT INTO fiscal_periods
       (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'Fixture period', 1, EXTRACT(YEAR FROM CURRENT_DATE)::int,
             date_trunc('year', CURRENT_DATE)::date,
             (date_trunc('year', CURRENT_DATE) + interval '1 year - 1 day')::date,
             'open')`,
    [companyId],
  );
  const { rows: today } = await client.query<{ d: string }>(
    "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d",
  );
  return { companyId, today: today[0]!.d };
}

async function buildFixture(client: PoolClient): Promise<Fixture | null> {
  const { companyId } = await makeCompany(client);

  const n = Math.floor(Math.random() * 1e9);
  const sourceId = await makeAccount(client, companyId, `SRC${n}`, 'expense', 'debit', null);
  const costOfSalesId = await makeAccount(client, companyId, `COS${n}`, 'expense', 'debit', 'cost_of_sales');
  const sameBandId = await makeAccount(client, companyId, `OPX${n}`, 'expense', 'debit', 'operating_expense');
  const contraId = await makeAccount(client, companyId, `LIA${n}`, 'liability', 'credit', 'current_liability');

  const { rows: entries } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries
       (company_id, entry_date, fiscal_period_id, description, source, status, created_by, posted_at)
     SELECT $1, CURRENT_DATE, fp.id, 'impact fixture', 'manual', 'posted', $2, now()
       FROM fiscal_periods fp
      WHERE fp.company_id = $1 AND fp.start_date <= CURRENT_DATE AND fp.end_date >= CURRENT_DATE
      LIMIT 1
     RETURNING id`,
    [companyId, USER_ID],
  );
  const entryId = entries[0]!.id;
  const { rows: lines } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     VALUES ($1, $2, $3, $4, 0) RETURNING id`,
    [companyId, entryId, sourceId, AMOUNT],
  );
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     VALUES ($1, $2, $3, 0, $4)`,
    [companyId, entryId, contraId, AMOUNT],
  );

  const { rows: today } = await client.query<{ d: string }>(
    "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d",
  );
  return {
    companyId, today: today[0]!.d, sourceId, costOfSalesId, sameBandId, lineId: lines[0]!.id,
  };
}

function inputFor(f: Fixture, targetId: string, moved: string[], subtype: string | null) {
  return {
    companyId: f.companyId,
    window: { start: f.today, end: f.today },
    movedLineIds: moved,
    sourceAccountId: f.sourceId,
    targetAccountId: targetId,
    targetAccountType: 'expense' as const,
    targetAccountSubtype: subtype,
    accountLabels: {
      [f.sourceId]: { code: 'SRC', name: 'Source' },
      [targetId]: { code: 'TGT', name: 'Target' },
    },
  };
}

/**
 * The drift check itself, tested where it CAN fail.
 *
 * The DB-gated tests above can only ever observe `basisFault === undefined`,
 * because two correct implementations reading the same window agree. That makes
 * them green against `const fault = undefined;`. This does not: a disagreement
 * is constructed directly, so the comparison has to be alive to pass.
 *
 * And the caveat the figure registry already carries: this check is NECESSARY
 * AND NOT SUFFICIENT. It proves the before-side query has not drifted from the
 * owning service. Nothing independent computes the AFTER side.
 */
function figures(over: Partial<ClassifiedFigures> = {}): ClassifiedFigures {
  return {
    revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0,
    operatingExpenses: 0, otherExpenses: 0, depreciation: 0,
    // Required on ClassifiedFigures. tsconfig excludes tests/**, so a missing
    // field here is invisible to tsc and to vitest: it would sit as `undefined`
    // behind the annotation and, the moment anyone adds operatingProfit to
    // PL_BANDS, `compareToOwner` would do undefined - undefined -> NaN and
    // report "no drift" — the exact failure the _bandsAreNumeric compile-time
    // guard exists to prevent, defeated because it cannot reach test files.
    operatingProfit: 0,
    netProfit: 0,
    totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
    currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
    cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
    unclassifiedCount: 0, unclassifiedTotal: 0,
    unclassifiedByType: {
      asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
      equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
      expense: { accounts: 0, amount: 0 },
    },
    ...over,
  };
}

describe('computeReclassImpact (real DB)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('PROJECTS the moved line onto the target band — the after side really moves', async (ctx) => {
    assertNotProductionDb('This test inserts GL accounts, journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period covering today'); return; }

      const impact = await als.run(ctxFor(client, f.companyId), () =>
        computeReclassImpact(inputFor(f, f.costOfSalesId, [f.lineId], 'cost_of_sales')));

      // The source has a NULL subtype, so the line defaults into operating
      // expenses; the target is cost_of_sales. Exactly AMOUNT must cross.
      const before = impact.profitAndLossBefore;
      const after = impact.profitAndLossAfter;
      expect(after.costOfSales - before.costOfSales).toBeCloseTo(AMOUNT, 2);
      expect(before.operatingExpenses - after.operatingExpenses).toBeCloseTo(AMOUNT, 2);
      // The bottom line does not move: a reclassification re-bands, it does not
      // create or destroy value.
      expect(after.netProfit).toBeCloseTo(before.netProfit, 2);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('leaves both sides identical when NOTHING moves', async (ctx) => {
    // The control for the test above: with an empty moved set the projection is
    // a no-op BY REQUEST, and the two sides must agree exactly. If they differ
    // here, the `proj` CTE is doing something other than re-pointing the moved
    // lines.
    assertNotProductionDb('This test inserts GL accounts, journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period covering today'); return; }

      const impact = await als.run(ctxFor(client, f.companyId), () =>
        computeReclassImpact(inputFor(f, f.costOfSalesId, [], 'cost_of_sales')));

      expect(impact.profitAndLossAfter.costOfSales)
        .toBeCloseTo(impact.profitAndLossBefore.costOfSales, 2);
      expect(impact.profitAndLossAfter.operatingExpenses)
        .toBeCloseTo(impact.profitAndLossBefore.operatingExpenses, 2);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('reports NO band change only when the two accounts really share a band', async (ctx) => {
    // This is the case `no_profit_and_loss_effect` is built on, and it must be
    // reached by the projection genuinely landing in the same band — not by the
    // projection failing to move anything.
    assertNotProductionDb('This test inserts GL accounts, journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period covering today'); return; }

      const impact = await als.run(ctxFor(client, f.companyId), () =>
        computeReclassImpact(inputFor(f, f.sameBandId, [f.lineId], 'operating_expense')));

      expect(impact.profitAndLossAfter.operatingExpenses)
        .toBeCloseTo(impact.profitAndLossBefore.operatingExpenses, 2);
      // And the ACCOUNT movement still shows it moved, which is the fact the
      // band totals cannot express.
      const source = impact.accounts.find((a) => a.accountId === f.sourceId)!;
      const target = impact.accounts.find((a) => a.accountId === f.sameBandId)!;
      expect(source.before - source.after).toBeCloseTo(AMOUNT, 2);
      expect(target.after - target.before).toBeCloseTo(AMOUNT, 2);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('signs an EXPENSE account debit-positive, not credit-positive', async (ctx) => {
    assertNotProductionDb('This test inserts GL accounts, journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period covering today'); return; }

      const impact = await als.run(ctxFor(client, f.companyId), () =>
        computeReclassImpact(inputFor(f, f.costOfSalesId, [f.lineId], 'cost_of_sales')));

      const source = impact.accounts.find((a) => a.accountId === f.sourceId)!;
      // The fixture posts a DEBIT of AMOUNT to an expense account. Normal
      // balance for an expense is debit, so `before` is POSITIVE. Drop the
      // expense arm of the sign flip and this reads −AMOUNT.
      expect(source.before).toBeCloseTo(AMOUNT, 2);
      expect(source.grossBefore).toBeCloseTo(AMOUNT, 2);
      expect(source.lineCountBefore).toBe(1);
      expect(source.after).toBeCloseTo(0, 2);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('RAISES a basis fault when the owning P&L service disagrees', async (ctx) => {
    // The peer is faked to a figure this file's own fold cannot produce, so the
    // comparison has to be live and its result has to reach the caller.
    // `const fault = undefined;` in computeReclassImpact goes red here.
    assertNotProductionDb('This test inserts GL accounts, journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period covering today'); return; }

      financialFigures.spy.mockImplementation(async () => ({
        inventoryClassified: false,
        retainedEarningsBroughtForward: 0,
        period: figures({ operatingExpenses: 12345.67 }),
        cumulative: figures(),
      }));
      try {
        const impact = await als.run(ctxFor(client, f.companyId), () =>
          computeReclassImpact(inputFor(f, f.costOfSalesId, [f.lineId], 'cost_of_sales')));
        expect(impact.basisFault).toBeDefined();
        expect(impact.basisFault).toContain('operatingExpenses');
        expect(impact.basisFault).toContain('12345.67');
      } finally {
        financialFigures.spy.mockReset();
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('agrees with the owning P&L service, and says so by NOT raising a fault', async (ctx) => {
    // `basisFault` is the check that this file's own query has not drifted from
    // financialFiguresService. Absent means they agree band for band. Break the
    // comparison and this stops being able to fail.
    assertNotProductionDb('This test inserts GL accounts, journal entries and lines.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await buildFixture(client);
      if (!f) { ctx.skip('no company with an open period covering today'); return; }

      const impact = await als.run(ctxFor(client, f.companyId), () =>
        computeReclassImpact(inputFor(f, f.costOfSalesId, [f.lineId], 'cost_of_sales')));
      expect(impact.basisFault).toBeUndefined();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);

});

describe('compareToOwner', () => {
  it('is silent when the two implementations agree', () => {
    expect(compareToOwner(figures({ revenue: 100 }), figures({ revenue: 100 }))).toBeUndefined();
  });

  it('names every band that disagrees, and both values', () => {
    const fault = compareToOwner(
      figures({ revenue: 100, operatingExpenses: 40 }),
      figures({ revenue: 250, operatingExpenses: 40 }),
    );
    expect(fault).toBeDefined();
    expect(fault).toContain('revenue');
    expect(fault).toContain('100');
    expect(fault).toContain('250');
    expect(fault).not.toContain('operatingExpenses');
  });

  it('fires at one cent — the threshold is a rounding allowance, not a tolerance', () => {
    expect(compareToOwner(figures({ netProfit: 1 }), figures({ netProfit: 1.01 }))).toBeDefined();
    expect(compareToOwner(figures({ netProfit: 1 }), figures({ netProfit: 1.004 }))).toBeUndefined();
  });

  it('checks EVERY P&L band, not just the first', () => {
    for (const band of [
      'revenue', 'otherIncome', 'costOfSales', 'grossProfit',
      'operatingExpenses', 'otherExpenses', 'netProfit',
    ] as const) {
      expect(compareToOwner(figures(), figures({ [band]: 99 }))).toContain(band);
    }
  });
});
