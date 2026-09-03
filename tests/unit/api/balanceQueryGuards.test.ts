/**
 * Two silent-omission defect classes in balance queries, guarded together
 * because the remaining sites carry both.
 *
 * CLASS 1 — `gl_accounts.is_active` used as a filter in a money query.
 * `is_active` is a chart-of-accounts picker flag: "stop offering this account
 * when coding new transactions". It says nothing about whether the account
 * still holds money. Production (Brightsphere, 2026-09-03): 1110 Bank -
 * Primary carries R6,550.00 while inactive, and dashboard cash dropped it.
 *
 * CLASS 2 — a predicate in a LEFT JOIN ON-clause that restricts NOTHING.
 * `FROM gl_accounts ga LEFT JOIN gl_journal_lines jl ... LEFT JOIN
 * gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status =
 * 'posted' AND je.entry_date BETWEEN ...` reads as if it selects posted lines
 * in a date range. It does not. A `jl` row whose entry fails those conditions
 * is not removed — the LEFT JOIN just yields NULL `je` columns, and the
 * aggregate over `jl.debit`/`jl.credit` counts it anyway. Confirmed in
 * production: budget-vs-actual for September 2026 reported R18,728,651.55 of
 * actuals against a true R0.00, because the date range filtered nothing and
 * every period showed all-time totals. Dashboard cash was understated by
 * R106,843.88 from draft journal lines leaking in the same way.
 *
 * The fix for class 2 is structural, not a tightened predicate: pre-aggregate
 * the journal lines in a subquery that owns its own WHERE, then LEFT JOIN the
 * result. That is the shape afsMappingQueries.getMappedTrialBalance already
 * uses, and it makes the mistake impossible to reintroduce by accident. These
 * tests therefore assert the raw `LEFT JOIN gl_journal_lines` is gone.
 *
 * SQL comments are stripped before matching, so an explanatory comment
 * mentioning a banned string cannot make a test pass the code has not earned.
 *
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
  withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(),
  withTransaction: (cb: (tx: unknown) => unknown) => cb(null),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
  withRole: (h: unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import dashboardStatsHandler from '../../../pages/api/accounting/dashboard-stats';
import cashMovementHandler from '../../../pages/api/accounting/reports/cash-movement';
import budgetVsActualHandler from '../../../pages/api/accounting/reports-budget-vs-actual';
import budgetVsActualExportHandler from '../../../pages/api/accounting/budget-vs-actual-export';
import { clientMetricsSnapshot } from '@/modules/bureau/services/bureauClientMetricsService';
import { autoGenerateGroupCOA, autoMapAccounts, getUnmappedAccounts } from '@/modules/accounting/services/reports/groupCoaMappingService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const GROUP = 'ggggggg1-0000-0000-0000-000000000001';

function mockReqRes(query: Record<string, string> = {}) {
  const req = { method: 'GET', query, companyId: COMPANY, userId: 'u-1' } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end(payload?: unknown) { this.sent = payload; return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

/** Joined template text, SQL comments removed, whitespace collapsed. */
function queryTexts(): string[] {
  return sqlMock.mock.calls.map((c) =>
    (c[0] as readonly string[])
      .join(' ? ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' '),
  );
}

function matching(re: RegExp): string[] {
  return queryTexts().filter((q) => re.test(q));
}

/** gl_accounts.is_active used as a predicate, whatever the alias. */
const GA_IS_ACTIVE = /\bga?\.is_active\s*=\s*(true|TRUE)/;

/**
 * The raw two-LEFT-JOIN shape whose journal-entry predicates restrict nothing.
 * Its absence is the guarantee; a tightened predicate would not be one.
 */
const LEAKY_LINE_JOIN = /LEFT JOIN gl_journal_lines/i;

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(async () => []);
});

describe('class 1 — is_active never filters a balance query', () => {
  it('dashboard-stats bank balances ignore is_active', async () => {
    const { req, res } = mockReqRes();
    await (dashboardStatsHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res);

    const [q] = matching(/account_subtype = 'bank'/);
    expect(q).toBeDefined();
    expect(q!).not.toMatch(GA_IS_ACTIVE);
  });

  it('cash-movement opening and movement queries ignore is_active', async () => {
    const { req, res } = mockReqRes({ from: '2026-01-01', to: '2026-01-31' });
    await (cashMovementHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res);

    const qs = matching(/FROM gl_accounts ga LEFT JOIN bank_transactions bt/i);
    expect(qs).toHaveLength(2); // opening balance + period movement
    for (const q of qs) {
      expect(q).toMatch(/account_subtype = 'bank'/);
      expect(q).not.toMatch(GA_IS_ACTIVE);
    }
  });

  it('reports-budget-vs-actual actuals ignore is_active', async () => {
    const { req, res } = mockReqRes({ period: 'ytd' });
    await (budgetVsActualHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res);

    const [q] = matching(/actual_amount/i);
    expect(q).toBeDefined();
    expect(q!).not.toMatch(GA_IS_ACTIVE);
  });

  it('budget-vs-actual-export actuals ignore is_active and keep the level-3 leaf filter', async () => {
    const { req, res } = mockReqRes({ period: 'ytd' });
    await (budgetVsActualExportHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res);

    const [q] = matching(/actual_amount/i);
    expect(q).toBeDefined();
    expect(q!).toMatch(/ga\.level = 3/);
    expect(q!).not.toMatch(GA_IS_ACTIVE);
  });

  it('bureau client cash ignores is_active', async () => {
    await clientMetricsSnapshot(COMPANY);

    const [q] = matching(/account_subtype = 'bank'/);
    expect(q).toBeDefined();
    expect(q!).not.toMatch(GA_IS_ACTIVE);
  });
});

describe('class 1 — group COA mapping cannot strand an account that holds money', () => {
  it('autoGenerateGroupCOA includes inactive accounts with posted activity', async () => {
    await autoGenerateGroupCOA(GROUP, COMPANY);

    const [q] = matching(/INSERT INTO group_accounts/i);
    expect(q).toBeDefined();
    expect(q!).toMatch(/a\.is_active = true OR EXISTS/);
    expect(q!).toMatch(/gl_journal_lines/i);
  });

  it('autoMapAccounts maps inactive company accounts with posted activity, and still skips retired GROUP accounts', async () => {
    await autoMapAccounts(GROUP, COMPANY);

    const [q] = matching(/INSERT INTO group_coa_mappings/i);
    expect(q).toBeDefined();
    expect(q!).toMatch(/ca\.is_active = true OR EXISTS/);
    // group_accounts.is_active is a genuine picker flag on the group chart:
    // do not map onto a group account the user has retired.
    expect(q!).toMatch(/ga\.is_active = true/);
  });

  it('group getUnmappedAccounts offers inactive accounts with posted activity', async () => {
    await getUnmappedAccounts(GROUP, COMPANY);

    const [q] = matching(/group_coa_mappings m/i);
    expect(q).toBeDefined();
    expect(q!).toMatch(/ca\.is_active = true OR EXISTS/);
  });
});

describe('class 2 — journal-entry predicates must actually restrict the summed rows', () => {
  it('dashboard-stats bank balances exclude draft journal lines', async () => {
    const { req, res } = mockReqRes();
    await (dashboardStatsHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res);

    const [q] = matching(/account_subtype = 'bank'/);
    expect(q!).not.toMatch(LEAKY_LINE_JOIN);
    // The posted filter now lives in a subquery that owns its own WHERE.
    expect(q!).toMatch(/JOIN gl_journal_entries je ON je\.id = jl\.journal_entry_id WHERE/i);
    expect(q!).toMatch(/je\.status = 'posted'/);
  });

  it('bureau client cash excludes draft journal lines', async () => {
    await clientMetricsSnapshot(COMPANY);

    const [q] = matching(/account_subtype = 'bank'/);
    expect(q!).not.toMatch(LEAKY_LINE_JOIN);
    expect(q!).toMatch(/je\.status = 'posted'/);
  });

  it('reports-budget-vs-actual confines actuals to the requested period', async () => {
    const { req, res } = mockReqRes({ period: 'ytd' });
    await (budgetVsActualHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res);

    const [q] = matching(/actual_amount/i);
    expect(q!).not.toMatch(LEAKY_LINE_JOIN);
    expect(q!).toMatch(/je\.entry_date >= \?/);
    expect(q!).toMatch(/je\.status = 'posted'/);
  });

  it('budget-vs-actual-export confines actuals to the requested period', async () => {
    const { req, res } = mockReqRes({ period: 'ytd' });
    await (budgetVsActualExportHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res);

    const [q] = matching(/actual_amount/i);
    expect(q!).not.toMatch(LEAKY_LINE_JOIN);
    expect(q!).toMatch(/je\.entry_date >= \?/);
    expect(q!).toMatch(/je\.status = 'posted'/);
  });

  it('cash-movement keeps its bank_transactions predicates in the joined table own ON-clause, which does restrict', async () => {
    const { req, res } = mockReqRes({ from: '2026-01-01', to: '2026-01-31' });
    await (cashMovementHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res);

    const qs = matching(/FROM gl_accounts ga LEFT JOIN bank_transactions bt/i);
    for (const q of qs) {
      // bt is BOTH the joined table and the aggregated one, so conditions on bt
      // in its own ON-clause genuinely exclude rows from SUM(bt.amount). This
      // is the correct use of the shape and must not be "fixed".
      expect(q).toMatch(/ON bt\.bank_account_id = ga\.id/);
      expect(q).toMatch(/bt\.status != 'excluded'/);
    }
  });
});
