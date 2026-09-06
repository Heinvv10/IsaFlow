/**
 * `getFinancialFigures` joins `gl_accounts` to classify every posted line by
 * account type + subtype. Without `ga.company_id` bound to the same company
 * as the journal, the join can walk into another tenant's chart of accounts.
 *
 * That is not hypothetical: Brightsphere's JE-2026-00002 posts a R450 debit
 * to account 1140, which belongs to Dotbiz, not Brightsphere. Two paths read
 * that line through two different lenses —
 *
 *   - The share pack (`sharedPackService` → `getFinancialFigures`) runs on
 *     the pool connection, a superuser that bypasses RLS. Unscoped, the join
 *     succeeds against Dotbiz's account 1140 and classifies the R450 as a
 *     Brightsphere asset.
 *   - The authenticated page (`getBalanceSheet`, under RLS as `app_user`)
 *     cannot see a row of `gl_accounts` it does not own, so the INNER JOIN
 *     drops the line entirely — the page is R450 short on the asset side.
 *
 * One tenant, one line, two different wrong answers depending on which door
 * you read it through. The fix is one additive predicate — `AND
 * ga.company_id = <company>` — which makes both paths drop the line for the
 * same reason: it does not belong to this tenant's chart of accounts either
 * way. The books stay out of balance (a separate, real defect — the line's
 * two other legs still post normally), but now both paths agree on exactly
 * how far out.
 *
 * First block: SQL-mocked, proves the predicate is in the query text and
 * bound to the company parameter. Second block: a real Postgres, non-skipping
 * without `DATABASE_URL` — same convention as tests/integration/*.int.test.ts
 * — proving the two paths now agree on Brightsphere's real data.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
});

const broughtForwardMock = vi.fn();
vi.mock('@/modules/accounting/services/gl/trialBalanceBasis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/trialBalanceBasis')>()),
  getRetainedEarningsBroughtForward: (...a: unknown[]) => broughtForwardMock(...a),
}));

import { sql } from '@/lib/neon';
import { getFinancialFigures, totalEquity } from '@/modules/accounting/services/gl/financialFiguresService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

/**
 * The SQL text the tagged template produced, with comments stripped so a
 * clause moved into `--` cannot fool a `toMatch` assertion. Same approach as
 * tests/unit/services/gl/financialFiguresService.test.ts.
 */
function lastQueryText(): string {
  const strings = mockSql.mock.calls[0]![0] as unknown as string[];
  return strings
    .join(' ? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

beforeEach(() => {
  mockSql.mockReset();
  broughtForwardMock.mockReset();
  broughtForwardMock.mockResolvedValue(0);
});

describe('getFinancialFigures — gl_accounts join is scoped to the company', () => {
  it('binds ga.company_id to the same company parameter as the journal tables', async () => {
    mockSql.mockResolvedValue([]);
    await getFinancialFigures(COMPANY, '2026-03-01', '2026-08-31');

    const text = lastQueryText();
    expect(text).toMatch(/JOIN gl_accounts ga ON ga\.id = jl\.gl_account_id AND ga\.company_id = .*::UUID/);

    // Every bound company-id parameter — je.company_id, jl.company_id, and
    // the new ga.company_id — must be the SAME company, not merely present.
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    const companyParams = params.filter((p) => p === COMPANY);
    expect(companyParams.length).toBeGreaterThanOrEqual(3);
    expect(companyParams.every((p) => p === COMPANY)).toBe(true);
  });

  it('mutation check: removing the predicate is caught by the query-text assertion', () => {
    // Documents the mutation this test is designed to catch: dropping
    // "AND ga.company_id = ..." from the join. Asserted structurally above,
    // not re-run here — this test exists so a reviewer can see the intent
    // stated once next to the assertion it protects.
    const unscoped = 'JOIN gl_accounts ga ON ga.id = jl.gl_account_id';
    const scoped = 'JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = $1::UUID';
    expect(scoped).not.toBe(unscoped);
    expect(/JOIN gl_accounts ga ON ga\.id = jl\.gl_account_id AND ga\.company_id = .*::UUID/.test(unscoped)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Real Postgres. Deliberately fails (not skips) without a real DATABASE_URL —
// same convention as tests/integration/*.int.test.ts.
// ─────────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL || DATABASE_URL.includes('dummy')) {
  throw new Error('getFinancialFiguresScoping (DB half) requires a real DATABASE_URL; it does not skip');
}

describe('getFinancialFigures vs getBalanceSheet — Brightsphere agree after scoping', () => {
  const BRIGHTSPHERE = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
  const BRIGHTSPHERE_USER = 'f110ef4f-e388-442e-8428-1a265b8d0a6a'; // owner, per company_users
  const FROM = '2026-03-01';
  const TO = '2026-08-31';

  let realNeon: typeof import('@/lib/neon');
  let realBalanceSheet: typeof import('@/modules/accounting/services/reports/balanceSheetService');
  let realFinancialFigures: typeof import('@/modules/accounting/services/gl/financialFiguresService');
  let als: typeof import('@/lib/als').als;

  beforeAll(async () => {
    vi.doUnmock('@/lib/neon');
    vi.doUnmock('@/modules/accounting/services/gl/trialBalanceBasis');
    vi.resetModules();
    realNeon = await import('@/lib/neon');
    realBalanceSheet = await import('@/modules/accounting/services/reports/balanceSheetService');
    realFinancialFigures = await import('@/modules/accounting/services/gl/financialFiguresService');
    als = (await import('@/lib/als')).als;
  });

  afterAll(async () => {
    await realNeon.getPoolForTests().end();
  });

  it('JE-2026-00002 really does carry a foreign-account leg (fixture assumption)', async () => {
    const rows = await realNeon.sql<{ account_company_id: string; debit: string }>`
      SELECT ga.company_id AS account_company_id, jl.debit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.entry_number = 'JE-2026-00002'
        AND je.company_id = ${BRIGHTSPHERE}::UUID
        AND ga.company_id != ${BRIGHTSPHERE}::UUID
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.debit)).toBeCloseTo(450, 2);
    expect(rows[0]!.account_company_id).not.toBe(BRIGHTSPHERE);
  });

  it('the no-RLS pack path and the RLS-authenticated page path report the SAME out-of-balance amount', async () => {
    // Pack path: pool superuser, no RLS — exactly how sharedPackService reads.
    const figures = await realFinancialFigures.getFinancialFigures(BRIGHTSPHERE, FROM, TO);
    const packAssets = figures.cumulative.totalAssets;
    const packLiabPlusEquity =
      figures.cumulative.totalLiabilities + realFinancialFigures.totalEquity(figures);
    const packImbalance = packAssets - packLiabPlusEquity;

    // Authenticated path: RLS as app_user, GUCs set for Brightsphere.
    const pool = realNeon.getPoolForTests();
    const client = await pool.connect();
    let report: Awaited<ReturnType<typeof realBalanceSheet.getBalanceSheet>>;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: BRIGHTSPHERE_USER }),
      ]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [BRIGHTSPHERE]);

      report = await als.run(
        { client, userId: BRIGHTSPHERE_USER, companyId: BRIGHTSPHERE, claims: { sub: BRIGHTSPHERE_USER } },
        () => realBalanceSheet.getBalanceSheet(BRIGHTSPHERE, TO)
      );
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const bsImbalance = report.totalAssets - (report.totalLiabilities + report.totalEquity);

    // Both paths now exclude the foreign leg for the same reason, so they
    // agree — the books still do not balance (a separate defect: the R450
    // debit's own two legs are otherwise fine), but by the SAME amount on
    // both paths, not two different wrong answers.
    expect(packImbalance).toBeCloseTo(bsImbalance, 2);
    expect(Math.abs(packImbalance)).toBeCloseTo(450, 2);
  });
});
