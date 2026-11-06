/**
 * A LEDGER FAULT IN A PACK'S CASH FLOW, on real PostgreSQL. A line added to an already-posted journal (the balance trigger
 * fires on the status change only) leaves 250 of cash no leg explains. The direct statement closes on the ledger and shows
 * it as `unexplainedDifference`; neither pack may hide it:
 *   - the management pack's cash_flow section prints an "Unexplained difference" group and stores the figure (snapshot and
 *     the commentary's input);
 *   - the board pack's operating cash flow stays the explained movement, and the gap travels beside it.
 * Rolled back with the request (`asRequest`). Fixture route: isaflow_schema_fixture (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { sql } from '@/lib/neon';
import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { cashFlowPackRows } from '@/modules/accounting/services/reports/packUnstatedRows';
import type { ManagementPackConfig, NoteContent, NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';

const told = vi.hoisted(() => ({ sections: [] as Array<{ sectionType: string; sectionData: Record<string, unknown> }> }));
vi.mock('@/modules/accounting/services/afs/packDeliveryService', () => ({ deliverPack: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/afs/packAiSummaryService', () => ({
  generateExecutiveSummary: vi.fn(async () => 'summary'),
  generateSectionCommentary: vi.fn(async (p: { sectionType: string; sectionData: Record<string, unknown> }) => {
    told.sections.push({ sectionType: p.sectionType, sectionData: p.sectionData });
    return 'commentary';
  }),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const START = '2026-03-01';
const END = '2026-03-31';
const GAP = 250;

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => { try { await dropTrackingFixture(pool, f); } finally { await pool.end(); } });

/** 250 of bank debit added to a posted March journal of company A: cash with no leg behind it. */
async function seedFault(c: PoolClient): Promise<void> {
  const je = (await c.query(`SELECT id FROM gl_journal_entries WHERE company_id = $1 AND status = 'posted' AND entry_date BETWEEN $2 AND $3 ORDER BY entry_date, entry_number, id LIMIT 1`, [f.a, START, END])).rows[0]!.id as string;
  await c.query('INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,0)', [f.a, je, f.acc.bank, GAP]);
}
const cents = (n: number) => Math.round(n * 100);

describe('a cash flow ledger fault reaches both packs', () => {
  it('the management pack prints and stores the unexplained difference', async () => {
    told.sections.length = 0;
    const config: ManagementPackConfig = {
      id: '', companyId: f.a, enabled: true, generationDay: 5, deliveryDay: 10, reviewRequired: true, sectionsEnabled: { cash_flow: true },
      recipients: [], packStyle: 'detailed', comparisonMode: 'prior_month', currencyDisplay: 'full',
    };
    const section = await asRequest(pool, f.a, f.userA, async () => {
      const { documentId } = await generateManagementPack({ companyId: f.a, period: '2026-03', config, triggeredBy: 'manual' });
      const rows = await sql`SELECT content, data_snapshot FROM afs_sections WHERE document_id = ${documentId}::UUID AND company_id = ${f.a}::UUID AND section_type = 'cash_flow'` as
        { content: NoteContent; data_snapshot: Record<string, unknown> }[];
      return rows[0]!;
    }, { appUser: true, before: seedFault });
    const table = section.content.blocks.find((b): b is NoteContentTable => b.type === 'table')!;
    const at = table.rows.findIndex((r) => r[0] === 'Unexplained difference');
    expect(at).toBeGreaterThan(-1);
    expect(table.rows[at + 2]?.[0]).toBe('Total unexplained difference');
    expect(section.data_snapshot).toMatchObject({ unexplainedDifference: GAP });
    expect(told.sections.find((s) => s.sectionType === 'cash_flow')?.sectionData).toMatchObject({ unexplainedDifference: GAP });
  });

  it('the board pack keeps operating cash as the explained movement and carries the gap beside it', async () => {
    const { direct, input } = await asRequest(pool, f.a, f.userA, async () => ({
      direct: await getCashFlowDirect(f.a, START, END),
      input: await getReportPackInput(f.a, 'Fixture Co', START, END),
    }), { appUser: true, before: seedFault });
    expect(direct.unexplainedDifference).toBe(GAP);
    expect(input.cashFlowUnexplained).toBe(GAP);
    expect(input.operatingCashFlow).toBe(direct.operatingTotal); // not operatingTotal + 250
    expect(cents(input.operatingCashFlow!) + cents(input.investingCashFlow!) + cents(input.financingCashFlow!) + cents(input.cashFlowUnexplained!)).toBe(cents(direct.netChange));
  });

  it("the report pack's cash flow section keeps the true opening cash and prints the gap as its own line", async () => {
    const { direct, input } = await asRequest(pool, f.a, f.userA, async () => ({
      direct: await getCashFlowDirect(f.a, START, END),
      input: await getReportPackInput(f.a, 'Fixture Co', START, END),
    }), { appUser: true, before: seedFault });
    const d = buildReportPack('management', input, START, END).sections.find((s) => s.type === 'cash_flow')!.data as Record<string, unknown>;
    expect(cents(d.openingCash as number)).toBe(cents(direct.openingCash)); // not opening + 250
    expect(cents(d.netCashFlow as number)).toBe(cents(direct.netChange));
    expect(cents(d.closingCash as number)).toBe(cents(direct.closingCash));
    expect(cashFlowPackRows(d).find((r) => r.label === 'Unexplained movement')?.value).toBe(GAP);
  });
});
