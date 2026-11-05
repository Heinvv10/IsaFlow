/**
 * The management pack's Income Statement and Balance Sheet, on real PostgreSQL: every figure is the one
 * the Reports screens' services give for the pack month, cell for cell; the tenant next door never
 * appears; and a balance sheet that cannot be built (no retained-earnings account) leaves its section
 * saying so, with the pack and the statement after it intact. Runs as app_user under forced RLS, as the
 * manual route does. Only the AI calls are stubbed.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { sql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import type { ManagementPackConfig, NoteContent, NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';

const told = vi.hoisted(() => ({ sections: [] as Array<{ sectionType: string; sectionData: Record<string, unknown> }>, summary: [] as Array<Record<string, unknown>> }));
vi.mock('@/modules/accounting/services/afs/packAiSummaryService', () => ({
  generateExecutiveSummary: vi.fn(async (p: Record<string, unknown>) => { told.summary.push(p); return 'summary'; }),
  generateSectionCommentary: vi.fn(async (p: { sectionType: string; sectionData: Record<string, unknown> }) => {
    told.sections.push({ sectionType: p.sectionType, sectionData: p.sectionData });
    return 'commentary';
  }),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const config = (mode: ManagementPackConfig['comparisonMode']): ManagementPackConfig => ({
  id: '', companyId: f.a, enabled: true, generationDay: 5, deliveryDay: 10, reviewRequired: true,
  sectionsEnabled: { ai_executive_summary: true, kpi_scorecard: true, income_statement: true, balance_sheet: true, cash_flow: true },
  recipients: [], packStyle: 'detailed', comparisonMode: mode, currencyDisplay: 'full',
});

const addRetainedEarnings = (c: PoolClient) => c.query(
  `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active, is_system_account)
   VALUES (gen_random_uuid(), $1, 'BT-3200', 'Retained Earnings', 'equity', 'retained_earnings', 'credit', 3, true, true)`, [f.a]);

async function pack(period: string, mode: ManagementPackConfig['comparisonMode'], before?: (c: PoolClient) => Promise<unknown>) {
  // The resolver caches a company's system accounts: a rolled-back account must not outlive its request.
  clearSystemAccountCache(f.a);
  return asRequest(pool, f.a, f.userA, async () => {
    const { documentId } = await generateManagementPack({ companyId: f.a, period, config: config(mode), triggeredBy: 'manual' });
    const rows = await sql`
      SELECT section_type, content, data_snapshot FROM afs_sections
       WHERE document_id = ${documentId}::UUID AND company_id = ${f.a}::UUID ORDER BY sort_order
    ` as { section_type: string; content: NoteContent; data_snapshot: Record<string, unknown> }[];
    const [y, m] = period.split('-').map(Number) as [number, number];
    const end = `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    const income = await getIncomeStatement(f.a, `${period}-01`, end);
    const balance = before ? await getBalanceSheet(f.a, end).catch(() => null) : null;
    return { sections: new Map(rows.map((r) => [r.section_type, r])), income, balance, end, kpis: kpiRows(rows) };
  }, { appUser: true, before }).finally(() => clearSystemAccountCache(f.a));
}
const kpiRows = (rows: Array<{ section_type: string; data_snapshot: Record<string, unknown> }>) =>
  (rows.find((r) => r.section_type === 'kpi_scorecard')?.data_snapshot.kpis ?? []) as Array<{ key: string; value: number }>;
const tableOf = (c: NoteContent | undefined): NoteContentTable => {
  const t = c?.blocks.find((b): b is NoteContentTable => b.type === 'table');
  if (!t) throw new Error('no table');
  return t;
};
const cell = (t: NoteContentTable, label: string, col = 1) => t.rows.find((r) => r[0] === label)?.[col];

describe('the pack\'s statements are the Reports screens\' figures', () => {
  it('income statement: every account line and total of the month, to the cent', async () => {
    const { sections, income } = await pack('2026-02', 'prior_month');
    const t = tableOf(sections.get('income_statement')?.content);
    expect(t.headers).toEqual(['', 'This month', 'Prior month']);
    expect(income.totalRevenue).toBeGreaterThan(1000);
    expect(cell(t, 'Total revenue')).toBe(formatMoney(income.totalRevenue));
    expect(cell(t, 'Total cost of sales')).toBe(formatMoney(income.totalCostOfSales));
    expect(cell(t, 'Gross profit')).toBe(formatMoney(income.grossProfit));
    expect(cell(t, 'Total other income')).toBe(formatMoney(income.totalOtherIncome));
    expect(cell(t, 'Operating profit')).toBe(formatMoney(income.operatingProfit));
    expect(cell(t, 'Total other expenses')).toBe(formatMoney(income.totalOtherExpenses));
    expect(cell(t, 'Net profit')).toBe(formatMoney(income.netProfit));
    for (const l of [...income.revenue, ...income.otherIncome, ...income.costOfSales, ...income.operatingExpenses, ...income.otherExpenses]) {
      expect(cell(t, `${l.accountCode} ${l.accountName}`)).toBe(formatMoney(l.amount));
    }
    // Company B's SECRET sales, the draft journal and the year-end close are in none of it.
    expect(JSON.stringify([...sections.values()])).not.toContain('SECRET');
  });

  it('income statement under all_three: the prior month and the same month last year come from the same report', async () => {
    const { sections } = await pack('2026-02', 'all_three');
    const t = tableOf(sections.get('income_statement')?.content);
    expect(t.headers).toEqual(['', 'This month', 'Prior month', 'Same month last year', 'Change on last year']);
    // 2026-01 is a ledger month; 2025-02 is before the ledger.
    expect(cell(t, 'Total revenue', 3)).toBe(formatMoney(0));
    expect(cell(t, 'Total revenue', 4)).toBe(cell(t, 'Total revenue', 1));
    expect(cell(t, 'Total revenue', 2)).not.toBe(formatMoney(0));
  });

  it('balance sheet: every account and total at the month end, to the cent', async () => {
    const { sections, balance, end } = await pack('2026-02', 'prior_month', addRetainedEarnings);
    expect(balance).not.toBeNull();
    const t = tableOf(sections.get('balance_sheet')?.content);
    expect(t.headers[1]).toBe('28 February 2026');
    expect(cell(t, 'Total assets')).toBe(formatMoney(balance!.totalAssets));
    expect(cell(t, 'Total equity')).toBe(formatMoney(balance!.totalEquity));
    expect(cell(t, 'Total liabilities and equity')).toBe(formatMoney(balance!.totalLiabilities + balance!.totalEquity));
    for (const l of [...balance!.assets, ...balance!.liabilities, ...balance!.equity]) {
      expect(cell(t, `${l.accountCode} ${l.accountName}`)).toBe(formatMoney(l.balance));
    }
    expect(sections.get('balance_sheet')?.data_snapshot).toMatchObject({ asAtDate: end, totalAssets: balance!.totalAssets });
    expect(JSON.stringify([...sections.values()])).not.toContain('SECRET');
  });

  it('a company whose balance sheet cannot be built still gets its pack, saying so in that section only', async () => {
    // The fixture has no retained-earnings account, which the report needs once there is a profit.
    const { sections } = await pack('2026-02', 'prior_month');
    expect(sections.get('balance_sheet')?.content.blocks).toEqual([{ type: 'paragraph', text: 'This statement could not be produced for this period.' }]);
    // The request's transaction survived the failed read (the SELECT above ran in it) and the section after it is whole.
    expect(tableOf(sections.get('income_statement')?.content).rows.length).toBeGreaterThan(3);
    expect(sections.get('cash_flow')?.content).toEqual({ title: 'Cash Flow', blocks: [] });
  });

  it('the scorecard, the stored snapshot, the section commentary and the executive summary all use the statement\'s turnover, not turnover plus the other income', async () => {
    told.sections.length = 0; told.summary.length = 0;
    const { sections, income, kpis } = await pack('2026-02', 'prior_month');
    // The fixture posts 12.34 of interest received (other income) every month beside 1591.15 of turnover.
    expect(income.totalOtherIncome).toBeGreaterThan(10);
    const t = tableOf(sections.get('income_statement')?.content);
    expect(cell(t, 'Total revenue')).toBe(formatMoney(income.totalRevenue));
    expect(sections.get('income_statement')?.data_snapshot).toEqual({ revenue: income.totalRevenue, cogs: income.totalCostOfSales, net_profit: income.netProfit });
    expect(told.sections.find((x) => x.sectionType === 'income_statement')?.sectionData.revenue).toBe(income.totalRevenue);
    expect(told.summary[0]?.revenue).toBe(income.totalRevenue);
    // KPI gross margin is gross profit over the SAME turnover the report divides by.
    const gross = kpis.find((k) => k.key === 'grossMarginPct')?.value;
    expect(gross).toBeCloseTo(income.grossMarginPct ?? NaN, 6);
  });
});
