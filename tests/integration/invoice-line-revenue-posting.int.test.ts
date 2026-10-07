/**
 * Migration 870, the posting half: a customer invoice whose lines name their
 * own revenue account, project and cost centre posts its revenue by line;
 * Project Profitability and the income statement see it; a credit note
 * reverses to the same legs pro rata; cancel nets every leg to zero; an
 * invoice with no coded line posts the single default_revenue leg it always
 * did; and a line the chart no longer accepts is refused BEFORE anything is
 * written — on approve (a 400 that commits nothing) and on Post to GL.
 *
 * Disposable databases only (migration 870 is not on isaflow_dev).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import {
  approveCustomerInvoice,
  InvoiceNotApprovableError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { getProjectProfitability } from '@/modules/accounting/services/reports/projectProfitabilityService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

// The sealed PDF is evidence storage, not posting; approve already treats its failure as non-blocking.
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Leg = { code: string; debit: number; credit: number; project: string | null; centre: string | null; vat: string | null };
let f: LineRevenueFixture;

type Line = { description: string; unitPrice: number; quantity?: number; glAccountId?: string; projectId?: string; costCenterId?: string };

async function draft(items: Line[]): Promise<string> {
  return (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 15, items,
  }))).id;
}

async function approved(items: Line[]): Promise<{ id: string; je: string }> {
  const id = await draft(items);
  const r = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return { id, je: r.glJournalEntryId! };
}

async function legs(journalId: string): Promise<Leg[]> {
  const rows = (await sql`
    SELECT a.account_code AS code, jl.debit, jl.credit, jl.project_id, jl.cost_center_id, jl.vat_type
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
    WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${f.fx.companyId}::UUID
    ORDER BY a.account_code, jl.project_id NULLS FIRST, jl.debit, jl.credit`) as Record<string, unknown>[];
  return rows.map((r) => ({
    code: String(r.code), debit: Number(r.debit), credit: Number(r.credit),
    project: r.project_id ? String(r.project_id) : null,
    centre: r.cost_center_id ? String(r.cost_center_id) : null,
    vat: r.vat_type ? String(r.vat_type) : null,
  }));
}

const journalCount = async () => Number(((await sql`
  SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);

describeIfDisposable('invoice line revenue posting (migration 870)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('posts each line to its own revenue account, project and cost centre; AR and VAT unchanged', async () => {
    const { je } = await approved([
      { description: 'TV spot', unitPrice: 10000, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { description: 'Grade', unitPrice: 4000, glAccountId: f.acct.postProduction, projectId: f.project.p1, costCenterId: f.centre.active },
      { description: 'Admin fee', unitPrice: 1000 },
    ]);
    const p1 = f.project.p1;
    expect(await legs(je)).toEqual([
      { code: '1100', debit: 17250, credit: 0, project: null, centre: null, vat: null },
      { code: '2120', debit: 0, credit: 2250, project: null, centre: null, vat: 'standard' },
      { code: '4000', debit: 0, credit: 1000, project: null, centre: null, vat: null },
      { code: '4100', debit: 0, credit: 10000, project: p1, centre: null, vat: null },
      { code: '4200', debit: 0, credit: 4000, project: p1, centre: f.centre.active, vat: null },
    ]);
  });

  it('an invoice with no coded line posts the single default_revenue leg, as before', async () => {
    const { je } = await approved([{ description: 'A', unitPrice: 600 }, { description: 'B', unitPrice: 400 }]);
    expect(await legs(je)).toEqual([
      { code: '1100', debit: 1150, credit: 0, project: null, centre: null, vat: null },
      { code: '2120', debit: 0, credit: 150, project: null, centre: null, vat: 'standard' },
      { code: '4000', debit: 0, credit: 1000, project: null, centre: null, vat: null },
    ]);
  });

  it('Project Profitability reports the revenue per production', async () => {
    const report = await inTx(f.fx, () => getProjectProfitability(f.fx.companyId, '2026-07-01', '2026-07-31'));
    const p1 = report.find((r) => r.projectId === f.project.p1)!;
    expect(p1.revenue).toBe(14000);
    expect(p1.revenueLines.map((l) => [l.accountCode, l.amount])).toEqual([['4100', 10000], ['4200', 4000]]);
  });

  it('a partial credit note reverses pro rata to the invoice legs; a full one to the cent', async () => {
    const { id } = await approved([
      { description: 'Shoot', unitPrice: 3000, glAccountId: f.acct.commercials, projectId: f.project.p2 },
      { description: 'Edit', unitPrice: 1000, glAccountId: f.acct.postProduction, projectId: f.project.p2 },
    ]);
    const note = async (subtotal: number) => {
      const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: id, creditDate: '2026-07-20', subtotal, taxRate: 15,
      }, f.fx.userId));
      return (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId))).glJournalEntryId!;
    };
    const p2 = f.project.p2;
    expect((await legs(await note(1000))).filter((l) => l.code.startsWith('4'))).toEqual([
      { code: '4100', debit: 750, credit: 0, project: p2, centre: null, vat: null },
      { code: '4200', debit: 250, credit: 0, project: p2, centre: null, vat: null },
    ]);
    expect((await legs(await note(3000))).filter((l) => l.code.startsWith('4')).map((l) => l.debit)).toEqual([2250, 750]);
    const report = await inTx(f.fx, () => getProjectProfitability(f.fx.companyId, '2026-07-01', '2026-07-31'));
    expect(report.find((r) => r.projectId === p2)?.revenue ?? 0).toBe(0);
  });

  it('an unlinked credit note posts untagged to default_revenue: its own project is display only (D1)', async () => {
    const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
      type: 'customer', clientId: f.fx.customerId, creditDate: '2026-07-21', subtotal: 100, taxRate: 0, projectId: f.project.p1,
    }, f.fx.userId));
    const je = (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId))).glJournalEntryId!;
    expect((await legs(je)).filter((l) => l.code === '4000')).toEqual([
      { code: '4000', debit: 100, credit: 0, project: null, centre: null, vat: null },
    ]);
  });

  it('cancel reverses every leg, so each project nets to zero', async () => {
    const { id, je } = await approved([
      { description: 'Rental', unitPrice: 500, glAccountId: f.acct.commercials, projectId: f.project.p2, costCenterId: f.centre.active },
    ]);
    await inTx(f.fx, () => cancelCustomerInvoice(f.fx.companyId, id, f.fx.userId));
    const net = (await sql`
      SELECT SUM(jl.credit - jl.debit) AS net FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.company_id = ${f.fx.companyId}::UUID AND (je.id = ${je}::UUID OR je.reversal_of_id = ${je}::UUID)
        AND jl.project_id = ${f.project.p2}::UUID`) as { net: string }[];
    expect(Number(net[0]!.net)).toBe(0);
  });

  it('approve refuses a line the chart no longer accepts BEFORE the status moves — no journal, still a draft', async () => {
    const id = await draft([{ description: 'Old line', unitPrice: 100, glAccountId: f.acct.commercials }]);
    await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${f.acct.commercials}::UUID`;
    try {
      const before = await journalCount();
      const err = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvoiceNotApprovableError);
      expect((err as Error).message).toMatch(/4100 Commercials.*inactive.*Recode the line/);
      expect(await journalCount()).toBe(before);
      expect(((await sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID`) as { status: string }[])[0]!.status).toBe('draft');
    } finally {
      await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${f.acct.commercials}::UUID`;
    }
  });

  it('approve refuses coded lines that no longer add up to the subtotal, before the status moves', async () => {
    const id = await draft([{ description: 'Split', unitPrice: 100, glAccountId: f.acct.commercials }]);
    await sql`UPDATE customer_invoices SET subtotal = 150, total_amount = 172.5, tax_amount = 22.5 WHERE id = ${id}::UUID`;
    const err = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceNotApprovableError);
    expect((err as Error).message).toMatch(/100\.00.*150\.00.*Re-save the draft/);
    expect(((await sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID`) as { status: string }[])[0]!.status).toBe('draft');
  });

  it.each([
    ['another company\'s account', 'gl_account_id', () => f.acct.foreign, /not in your company/],
    ['another company\'s project', 'project_id', () => f.project.foreign, /not in your company/],
    ['another company\'s cost centre', 'cost_center_id', () => f.centre.foreign, /not in your company/],
    ['an expense account', 'gl_account_id', () => f.acct.expense, /6100 Crew.*not a revenue account/],
  ])('Post to GL refuses a stored line naming %s, before any journal is written', async (_label, column, value, message) => {
    const id = await draft([{ description: 'Forged later', unitPrice: 100 }]);
    // A row no write path accepts — forged as the database would allow it.
    await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    if (column === 'gl_account_id') await sql`UPDATE customer_invoice_items SET gl_account_id = ${value()}::UUID WHERE invoice_id = ${id}::UUID`;
    if (column === 'project_id') await sql`UPDATE customer_invoice_items SET project_id = ${value()}::UUID WHERE invoice_id = ${id}::UUID`;
    if (column === 'cost_center_id') await sql`UPDATE customer_invoice_items SET cost_center_id = ${value()}::UUID WHERE invoice_id = ${id}::UUID`;
    const before = await journalCount();
    const err = await inTx(f.fx, () => postCustomerInvoiceToGL(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((err as Error).message).toMatch(message);
    expect(await journalCount()).toBe(before);
  });

  it('Post to GL refuses coded lines that no longer add up to the subtotal', async () => {
    const id = await draft([{ description: 'Split', unitPrice: 100, glAccountId: f.acct.commercials }]);
    await sql`UPDATE customer_invoices SET status = 'approved', subtotal = 150, total_amount = 172.5, tax_amount = 22.5 WHERE id = ${id}::UUID`;
    const err = await inTx(f.fx, () => postCustomerInvoiceToGL(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((err as Error).message).toMatch(/100\.00.*150\.00/);
  });
});
