/**
 * The management pack's Cash Flow, Debtors Ageing, Creditors Ageing and Bank Reconciliation sections, on real
 * PostgreSQL: every printed cell is the one the report's own service gives for the same company and period
 * (getCashFlowDirect, getAgingReport, getReconciliations); the tenant next door never appears; and a
 * report that cannot be read leaves only its own section saying so. Runs as app_user under forced RLS, as the
 * manual route does. Only the AI calls are stubbed (and record what each section's commentary is told).
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
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getUnappliedByEntity } from '@/modules/accounting/services/shared/agedNetting';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getReconciliations } from '@/modules/accounting/services/bank/bankReconciliationService';
import type { ManagementPackConfig, NoteContent, NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';

const told = vi.hoisted(() => ({ sections: [] as Array<{ sectionType: string; sectionData: Record<string, unknown> }>, delivered: [] as string[] }));
vi.mock('@/modules/accounting/services/afs/packDeliveryService', () => ({ deliverPack: vi.fn(async (docId: string) => { told.delivered.push(docId); }) }));
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
const PERIOD = '2026-02';
const START = '2026-02-01';
const END = '2026-02-28';

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const config = (sections: string[], reviewRequired = true): ManagementPackConfig => ({
  id: '', companyId: f.a, enabled: true, generationDay: 5, deliveryDay: 10, reviewRequired,
  sectionsEnabled: Object.fromEntries(sections.map((s) => [s, true])),
  recipients: [], packStyle: 'detailed', comparisonMode: 'prior_month', currencyDisplay: 'full',
});
const ALL = ['cash_flow', 'debtors_ageing', 'creditors_ageing', 'bank_reconciliation'];

/** Open invoices and reconciliations for company A, and the same for company B (whose names must never print). */
async function seedBooks(c: PoolClient): Promise<void> {
  const q = (text: string, params: unknown[] = []) => c.query(text, params);
  const cust = async (co: string, name: string) => (await q('INSERT INTO customers (id, company_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id', [co, name])).rows[0].id as string;
  const supp = async (co: string, name: string) => (await q('INSERT INTO suppliers (id, company_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id', [co, name])).rows[0].id as string;
  const inv = (co: string, customer: string, no: string, date: string, due: string, total: number) => q(
    `INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$2,$3,$4,$5,'approved',$6,0,$7)`, [co, customer, no, date, due, total, f.userA]);
  const bill = (co: string, supplier: string, no: string, date: string, due: string, total: number) => q(
    `INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,$4,$5,'approved',$6,0,$7)`, [co, supplier, no, date, due, total, f.userA]);
  const [alpha, beta] = [await cust(f.a, 'Alpha Customer'), await cust(f.a, 'Beta Customer')];
  await inv(f.a, alpha, 'MP-1', '2026-01-05', '2026-02-04', 1200);
  await inv(f.a, alpha, 'MP-2', '2025-10-01', '2025-11-01', 300);
  await inv(f.a, beta, 'MP-3', '2026-02-10', '2026-03-10', 450.5);
  // An open dispute: the age columns carry 700 of this 1 000 invoice and the 300 in dispute is still owed.
  const disputed = (await q(`INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
    VALUES ($1,$2,$2,'MP-DSP','2026-01-05','2026-02-04','approved',1000,0,$3) RETURNING id`, [f.a, beta, f.userA])).rows[0].id as string;
  await q(`INSERT INTO customer_invoice_disputes (company_id, customer_invoice_id, reason, raised_by, raised_at, disputed_amount)
    VALUES ($1,$2,'quality',$3,'2026-02-10',300)`, [f.a, disputed, f.userA]);
  const gamma = await supp(f.a, 'Gamma Supplier');
  await bill(f.a, gamma, 'MB-1', '2026-01-20', '2026-02-19', 800);
  // No due date: the screen ages it from the bill date, so it is in the total (and the 1–30 or older columns), never dropped.
  await q(`INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
           VALUES ($1,$2,'MB-NODUE','2026-01-10',NULL,'approved',5000,0,$3)`, [f.a, gamma, f.userA]);
  const secretCust = await cust(f.b, 'SECRET Customer B');
  await inv(f.b, secretCust, 'MPB-1', '2026-01-05', '2026-02-04', 99999);
  const secretSupp = await supp(f.b, 'SECRET Supplier B');
  await bill(f.b, secretSupp, 'MBB-1', '2026-01-20', '2026-02-19', 88888);
  const rec = (co: string, account: string, date: string, stmt: number, gl: number, reconciled: number, status: string) => q(
    `INSERT INTO bank_reconciliations (id, company_id, bank_account_id, statement_date, statement_balance, gl_balance, reconciled_balance, status, started_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`, [co, account, date, stmt, gl, reconciled, status, f.userA]);
  await rec(f.a, f.acc.bank, '2026-01-31', 500, 505, 498, 'completed');
  await rec(f.a, f.acc.bank, '2026-02-20', 1200.5, 1210.5, 1195, 'completed');
  await rec(f.a, f.acc.bank, '2026-02-27', 999, 999, 999, 'in_progress');
  await rec(f.a, f.acc.bank, '2026-03-31', 7777, 7777, 7777, 'completed');
  await rec(f.b, f.acc.bSales, '2026-02-27', 66666, 66666, 66666, 'completed');
  // A second bank account of company A that was never reconciled.
  await q(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
           VALUES (gen_random_uuid(), $1, 'BT-1099', 'Never Reconciled Bank', 'asset', 'bank', 'debit', 3, true)`, [f.a]);
  // Deactivated bank accounts of company A: one holding money on its statement lines, one only in the ledger, one empty.
  const closed = async (code: string, name: string) => (await q(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
     VALUES (gen_random_uuid(), $1, $2, $3, 'asset', 'bank', 'debit', 3, false) RETURNING id`, [f.a, code, name])).rows[0].id as string;
  const statementOnly = await closed('BT-1096', 'Closed Statement Bank');
  await q(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description) VALUES ($1, $2, '2026-01-15', 250, 'closed')`, [f.a, statementOnly]);
  const ledgerOnly = await closed('BT-1097', 'Closed Ledger Bank');
  const je = (await q(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
                       VALUES ($1, 'MP-CLOSED-1', '2026-01-15', 'closed', 'manual', 'posted', $2) RETURNING id`, [f.a, f.userA])).rows[0].id;
  await q(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 400, 0), ($1, $2, $4, 0, 400)`, [f.a, je, ledgerOnly, f.acc.bank]);
  await closed('BT-1098', 'Retired Empty Bank');
}

async function pack(sections: string[], before?: (c: PoolClient) => Promise<unknown>, readReports = before === seedBooks, opts: { period?: string; reviewRequired?: boolean } = {}) {
  told.sections.length = 0;
  told.delivered.length = 0;
  return asRequest(pool, f.a, f.userA, async () => {
    const { documentId } = await generateManagementPack({ companyId: f.a, period: opts.period ?? PERIOD, config: config(sections, opts.reviewRequired ?? true), triggeredBy: 'manual' });
    const status = ((await sql`SELECT status FROM afs_documents WHERE id = ${documentId}::UUID AND company_id = ${f.a}::UUID`) as { status: string }[])[0]?.status;
    const rows = await sql`
      SELECT section_type, content, data_snapshot FROM afs_sections
       WHERE document_id = ${documentId}::UUID AND company_id = ${f.a}::UUID ORDER BY sort_order
    ` as { section_type: string; content: NoteContent; data_snapshot: Record<string, unknown> }[];
    const reports = readReports ? {
      cash: await getCashFlowDirect(f.a, START, END),
      ledgerCash: (await getCashBalance(f.a, END)).total,
      ar: await getARAging(f.a, END),
      ap: await getAPAging(f.a, END),
      arUnapplied: await getUnappliedByEntity(f.a, 'ar', END),
      recs: await getReconciliations(f.a),
      accounts: await getBankAccountsStatus(f.a),
    } : null;
    return { sections: new Map(rows.map((r) => [r.section_type, r])), reports, status, delivered: told.delivered.length };
  }, { appUser: true, before });
}
const tableOf = (c: NoteContent | undefined): NoteContentTable => {
  const t = c?.blocks.find((b): b is NoteContentTable => b.type === 'table');
  if (!t) throw new Error('no table');
  return t;
};
const row = (t: NoteContentTable, label: string) => t.rows.find((r) => r[0] === label);
const m = formatMoney;

describe('every cell is the report service\'s figure for the same company and month', () => {
  it('cash flow: opening, each item, each total, closing', async () => {
    const { sections, reports } = await pack(ALL, seedBooks);
    const cash = reports!.cash;
    const t = tableOf(sections.get('cash_flow')?.content);
    expect(t.headers).toEqual(['', 'This month', 'Prior month']);
    expect(cash.operatingItems.length + cash.investingItems.length + cash.financingItems.length).toBeGreaterThan(0);
    expect(row(t, 'Opening cash')?.[1]).toBe(m(cash.openingCash));
    for (const i of [...cash.operatingItems, ...cash.investingItems, ...cash.financingItems]) expect(row(t, i.label)?.[1]).toBe(m(i.amount));
    expect(row(t, 'Net cash from operating activities')?.[1]).toBe(m(cash.operatingTotal));
    expect(row(t, 'Net change in cash')?.[1]).toBe(m(cash.netChange));
    expect(row(t, 'Closing cash')?.[1]).toBe(m(cash.closingCash));
    // The statement ties: opening plus the net change is the closing cash, in the service's figures and in what is printed.
    expect(cash.openingCash + cash.netChange).toBeCloseTo(cash.closingCash, 2);
    expect(cash.operatingTotal + cash.investingTotal + cash.financingTotal).toBeCloseTo(cash.netChange, 2);
    expect(m(cash.openingCash + cash.netChange)).toBe(row(t, 'Closing cash')?.[1]);
    expect(JSON.stringify(sections.get('cash_flow')?.content.blocks)).toContain('Direct method');
    expect(sections.get('cash_flow')?.data_snapshot).toMatchObject({ openingCash: cash.openingCash, closingCash: cash.closingCash, netChange: cash.netChange });
    // whole cents all through the stored figures, and the closing cash is the ledger's
    for (const v of Object.values(sections.get('cash_flow')!.data_snapshot).filter((x): x is number => typeof x === 'number')) expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
    expect(sections.get('cash_flow')?.data_snapshot).toMatchObject({ unexplainedDifference: 0, closingCash: reports!.ledgerCash });
  });

  const AGES = ['current', 'days30', 'days60', 'days90', 'days120Plus'] as const;
  it.each([['debtors_ageing', 'ar', 'Alpha Customer', 'Beta Customer'], ['creditors_ageing', 'ap', 'Gamma Supplier', null]] as const)(
    '%s: every balance row, and the Total is what the service says is owed (disputed amounts included)',
    async (key, side, ...names) => {
      const { sections, reports } = await pack(ALL, seedBooks);
      const rows = reports![side];
      const t = tableOf(sections.get(key)?.content);
      const disputedCol = side === 'ar' ? ['Disputed'] : [];
      expect(rows.length).toBeGreaterThan(0);
      expect(t.headers.slice(1)).toEqual(['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days', ...disputedCol, 'Total']);
      // Whether the service's total is net of the dispute or includes it, what is owed is the age columns plus the dispute.
      const owed = (b: (typeof rows)[number]) => Math.round((AGES.reduce((s2, k) => s2 + b[k], 0) + (b.disputed ?? 0)) * 100) / 100;
      for (const b of rows) {
        expect(row(t, b.entityName)?.slice(1)).toEqual([...AGES.map((k) => m(b[k])), ...(side === 'ar' ? [m(b.disputed ?? 0)] : []), m(owed(b))]);
      }
      // The screen's footer is the sum of the service's rows; the pack's is that sum plus what is in dispute.
      const sum = (f: (b: (typeof rows)[number]) => number) => Math.round(rows.reduce((s2, b) => s2 + f(b), 0) * 100) / 100;
      expect(row(t, 'Total')?.at(-1)).toBe(m(sum(owed)));
      for (const n of names) if (n) expect(row(t, n)).toBeDefined();
      expect(sections.get(key)?.data_snapshot).toMatchObject({ asAt: END, totals: { total: sum(owed) } });
    },
  );

  it('debtors: an open dispute is still owed, so Total includes it and Disputed shows it', async () => {
    const { sections, reports } = await pack(ALL, seedBooks);
    const t = tableOf(sections.get('debtors_ageing')?.content);
    const beta = reports!.ar.find((b) => b.entityName === 'Beta Customer')!;
    // MP-3 450.50 (due 10 Mar: current) + MP-DSP 1 000 (due 4 Feb: 24 days late, 300 in dispute): the service ages 700 of it.
    expect(beta.disputed).toBe(300);
    expect(row(t, 'Beta Customer')?.slice(1)).toEqual([450.5, 700, 0, 0, 0, 300, 1450.5].map(m));
    // Every invoice that is open is in the grand total, disputed or not.
    expect(row(t, 'Total')?.at(-1)).toBe(m(1200 + 300 + 450.5 + 1000));
  });

  it('a bill with no due date is aged from its bill date and is in the creditors total, as the Aged Creditors service has it', async () => {
    const { sections, reports } = await pack(ALL, seedBooks);
    const t = tableOf(sections.get('creditors_ageing')?.content);
    const gamma = reports!.ap.find((b) => b.entityName === 'Gamma Supplier')!;
    // MB-1 800 (due 19 Feb, 9 days late) + MB-NODUE 5 000 (no due date: 49 days from the bill date).
    expect(gamma.total).toBe(5800);
    expect(row(t, 'Gamma Supplier')?.at(-1)).toBe(m(5800));
    expect(row(t, 'Total')?.at(-1)).toBe(m(reports!.ap.reduce((s2, b) => s2 + b.total, 0)));
  });

  it('debtors ageing buckets the invoices by their age at the month end (the 2025 invoice is 90+ days)', async () => {
    const { sections } = await pack(ALL, seedBooks);
    const alpha = row(tableOf(sections.get('debtors_ageing')?.content), 'Alpha Customer');
    // [name, current, 1–30, 31–60, 61–90, 90+, disputed, total]: the 4 Feb due date is 24 days late, the 1 Nov one 119.
    expect(alpha?.slice(1)).toEqual([0, 1200, 0, 0, 300, 0, 1500].map(m));
  });

  it('the commentary for ageing is told no customer or supplier name', async () => {
    await pack(ALL, seedBooks);
    const ageingTold = told.sections.filter((x) => x.sectionType.endsWith('_ageing'));
    expect(ageingTold).toHaveLength(2);
    expect(JSON.stringify(ageingTold)).not.toMatch(/Alpha|Beta|Gamma/);
  });

  it('bank reconciliation: the latest COMPLETED session on or before the month end, never a later or an in-progress one', async () => {
    const { sections, reports } = await pack(ALL, seedBooks);
    const t = tableOf(sections.get('bank_reconciliation')?.content);
    const mine = reports!.recs.filter((r) => r.bankAccountId === f.acc.bank && r.status === 'completed' && r.statementDate <= END)
      .sort((a, b) => b.statementDate.localeCompare(a.statementDate))[0]!;
    expect(mine.statementDate).toBe('2026-02-20');
    const main = reports!.accounts.find((a) => a.id === f.acc.bank)!;
    // Non-zero on both measures: statement less GL is -10 and the stored reconciled balance is 5.5 below the statement.
    expect(row(t, main.accountName)?.slice(1)).toEqual(['20 February 2026', m(mine.statementBalance), m(mine.glBalance), m(mine.reconciledBalance), m(-10)]);
    expect(mine.statementBalance - mine.glBalance).not.toBe(0);
    expect(mine.statementBalance - mine.reconciledBalance).not.toBe(0);
    expect(JSON.stringify(t)).not.toContain('7 777');
    const blocks = JSON.stringify(sections.get('bank_reconciliation')?.content.blocks);
    expect(blocks).toContain('a reconciliation to 27 February 2026 is in progress and not included');
  });

  it('a bank account of the company with no reconciliation is listed as such', async () => {
    const { sections } = await pack(ALL, seedBooks);
    expect(row(tableOf(sections.get('bank_reconciliation')?.content), 'Never Reconciled Bank')).toEqual(['Never Reconciled Bank', 'No reconciliation', '—', '—', '—', '—']);
  });

  it('a deactivated bank account holding money is listed; one where nothing ever happened is not', async () => {
    const { sections } = await pack(ALL, seedBooks);
    const t = tableOf(sections.get('bank_reconciliation')?.content);
    expect(row(t, 'Closed Statement Bank')?.[1]).toBe('No reconciliation');
    expect(row(t, 'Closed Ledger Bank')?.[1]).toBe('No reconciliation');
    expect(row(t, 'Retired Empty Bank')).toBeUndefined();
    // Never Reconciled Bank and the two closed accounts holding money.
    expect(told.sections.find((s) => s.sectionType === 'bank_reconciliation')?.sectionData).toMatchObject({ accountsWithoutReconciliation: 3 });
  });

  it('nothing of company B reaches any section, and each section\'s commentary was told its own figures', async () => {
    const { sections } = await pack(ALL, seedBooks);
    expect(JSON.stringify([...sections.values()])).not.toMatch(/SECRET|99 ?999|88 ?888|66 ?666/);
    const sectionData = (type: string) => told.sections.find((s) => s.sectionType === type)?.sectionData ?? {};
    expect(sectionData('cash_flow')).toHaveProperty('closingCash');
    expect(sectionData('debtors_ageing')).toMatchObject({ asAt: END });
    expect(sectionData('creditors_ageing')).toMatchObject({ asAt: END });
    expect(sectionData('bank_reconciliation')).toHaveProperty('accounts');
  });

  it('a company with no balances and no reconciliations gets sentences, not empty tables', async () => {
    const { sections } = await pack(ALL);
    expect(sections.get('debtors_ageing')?.content.blocks).toEqual([{ type: 'paragraph', text: 'No open customer balances at 28 February 2026.' }]);
    expect(sections.get('creditors_ageing')?.content.blocks).toEqual([{ type: 'paragraph', text: 'No open supplier balances at 28 February 2026.' }]);
    // The fixture's bank account exists but was never reconciled: it is listed, not hidden.
    expect(row(tableOf(sections.get('bank_reconciliation')?.content), 'Bank')?.[1]).toBe('No reconciliation');
  });

  it('a read that FAILS (not a refusal) aborts the pack: no document is left behind', async () => {
    // The table the reconciliation read needs is gone for this (rolled-back) request only: a real SQL error.
    await expect(pack([...ALL, 'kpi_scorecard'], (c) => c.query('ALTER TABLE bank_reconciliations RENAME TO bank_reconciliations_gone'), false))
      .rejects.toThrow(/bank_reconciliations/);
    const left = await pool.query(`SELECT 1 FROM afs_documents WHERE company_id = $1 AND document_type = 'management_pack' AND period = $2`, [f.a, PERIOD]);
    expect(left.rowCount).toBe(0);
  });

  it('no customer, supplier or bank account name, number or narrative reaches the model', async () => {
    await pack([...ALL, 'ai_executive_summary'], async (c) => {
      await seedBooks(c);
      await c.query("UPDATE gl_accounts SET account_name = 'ZZPRIVATE FNB 62123456789', bank_account_number = '62123456789' WHERE id = $1", [f.acc.bank]);
    }, false);
    expect(told.sections.length).toBeGreaterThan(0);
    expect(JSON.stringify(told.sections)).not.toMatch(/ZZPRIVATE|62123456789|Alpha|Beta|Gamma/);
  });

  it('a budget-engine FAULT holds an auto-delivered pack as a draft; a clean one is signed off and delivered', async () => {
    // 2026-09 is a month the fixture has a budget for. The table the engine reads is gone for this (rolled-back) request only.
    const held = await pack(['income_vs_budget', 'kpi_scorecard'], (c) => c.query('ALTER TABLE budget_versions RENAME TO budget_versions_gone'), false, { period: '2026-09', reviewRequired: false });
    expect(held.status).toBe('draft');
    expect(held.delivered).toBe(0);
    expect(JSON.stringify(held.sections.get('income_vs_budget')?.content.blocks)).toContain('Budget figures are unavailable');
    const clean = await pack(['income_vs_budget', 'kpi_scorecard'], undefined, false, { period: '2026-09', reviewRequired: false });
    expect(clean.status).toBe('signed_off');
    expect(clean.delivered).toBe(1);
  });
});
