/**
 * Budgets P3 PR-D, on real PostgreSQL: a generated management pack prints the
 * tracking engine's figures for the pack month, cell for cell; `all_three`
 * reads the same month a year earlier from the ledger; a year with no budget
 * prints the sentence. Runs as app_user under forced RLS, as the manual route
 * does. Only the AI calls are stubbed.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { sql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import type { ManagementPackConfig, NoteContent, NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';

vi.mock('@/modules/accounting/services/afs/packAiSummaryService', () => ({
  generateExecutiveSummary: vi.fn(async () => 'summary'),
  generateSectionCommentary: vi.fn(async () => 'commentary'),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const config = (comparisonMode: ManagementPackConfig['comparisonMode']): ManagementPackConfig => ({
  id: '', companyId: f.a, enabled: true, generationDay: 5, deliveryDay: 10, reviewRequired: true,
  sectionsEnabled: { income_statement: true, income_vs_budget: true, budget_variance: true },
  recipients: [], packStyle: 'detailed', comparisonMode, currencyDisplay: 'full',
});

/** Generates inside a rolled-back request; returns the stored sections and what the engine says for that month. */
async function pack(mode: ManagementPackConfig['comparisonMode'], period: string) {
  return asRequest(pool, f.a, f.userA, async () => {
    const { documentId } = await generateManagementPack({ companyId: f.a, period, config: config(mode), triggeredBy: 'manual' });
    const rows = await sql`
      SELECT section_type, content, data_snapshot FROM afs_sections
       WHERE document_id = ${documentId}::UUID AND company_id = ${f.a}::UUID ORDER BY sort_order
    ` as { section_type: string; content: NoteContent; data_snapshot: Record<string, unknown> }[];
    const report = await buildBudgetTrackingReport(f.a, { period: 'month', month: period });
    return { sections: new Map(rows.map((r) => [r.section_type, r])), report };
  }, { appUser: true });
}
const firstTable = (c: NoteContent | undefined): NoteContentTable => {
  const t = c?.blocks.find((b): b is NoteContentTable => b.type === 'table');
  if (!t) throw new Error('no table');
  return t;
};

describe('a generated pack prints the engine', () => {
  it('income_vs_budget: every band\'s Actual, Budget and Var R, to the cent', async () => {
    const { sections, report } = await pack('budget', '2026-09');
    const rows = firstTable(sections.get('income_vs_budget')?.content).rows;
    expect(rows.map((r) => r[0])).toEqual(report.bands.map((b) => b.label));
    expect(rows.map((r) => r.slice(1, 4))).toEqual(report.bands.map((b) => [
      formatMoney(b.actual),
      b.budget === null ? '—' : formatMoney(b.budget),
      b.variance === null ? '—' : formatMoney(b.variance),
    ]));
    const net = report.bands.find((b) => b.key === 'net_profit');
    expect(net?.budget).not.toBeNull();
    expect(sections.get('income_vs_budget')?.data_snapshot).toMatchObject({ version: 'Original · approved', month: '2026-09' });
  });

  it('budget_variance: the largest |variance| lines of the engine, by account code', async () => {
    const { sections, report } = await pack('budget', '2026-09');
    const printed = firstTable(sections.get('budget_variance')?.content).rows.map((r) => r[0]);
    const expected = report.lines.filter((l) => l.variance !== null && l.variance !== 0)
      .sort((a, b) => Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0))
      .map((l) => `${l.accountCode} ${l.accountName}`);
    expect(expected.length).toBeGreaterThan(1);
    expect(printed).toEqual(expected);
  });

  it('all_three reads the same month a year earlier off the ledger', async () => {
    const { sections } = await pack('all_three', '2026-03');
    // 2025-03 is before the fixture's ledger: an empty month, and the same month of 2026 has revenue.
    const rows = firstTable(sections.get('income_statement')?.content).rows;
    expect(rows[0]?.[3]).toBe(formatMoney(0));
    expect(rows[0]?.[4]).toBe(rows[0]?.[1]);
    const later = await pack('all_three', '2027-02');
    // 2026-02 is the fixture's second ledger month: 1000 + 13.37 + 500.01 + 77.77 + 12.34 of revenue.
    expect(firstTable(later.sections.get('income_statement')?.content).rows[0]?.[3]).toBe(formatMoney(1603.49));
  });

  it('a month in a year with no budget prints the sentence, not a table', async () => {
    const { sections } = await pack('budget', '2026-01');
    for (const s of ['income_vs_budget', 'budget_variance']) {
      expect(sections.get(s)?.content.blocks).toEqual([{ type: 'paragraph', text: 'No budget for FY2026 in this pack\'s month.' }]);
    }
  });
});
