/**
 * Migration 874, the posting half: a customer invoice whose lines name their
 * own revenue account, job and (migration 870) CC1 / CC2 / BU posts its
 * revenue by line, the customer's FNO on every revenue leg;
 * Project Profitability and the income statement see it; a credit note
 * reverses to the same legs pro rata; cancel nets every leg to zero; an
 * invoice with no coded line posts the single default_revenue leg it always
 * did; and a line the chart no longer accepts is refused BEFORE anything is
 * written — on approve (a 400 that commits nothing) and on Post to GL.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
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
type Leg = { code: string; debit: number; credit: number; project: string | null; cc1: string | null; cc2: string | null; bu: string | null; vat: string | null };
const L = (code: string, debit: number, credit: number, extra: Partial<Leg> = {}): Leg =>
  ({ code, debit, credit, project: null, cc1: null, cc2: null, bu: null, vat: null, ...extra });
let f: LineRevenueFixture;

type Line = { description: string; unitPrice: number; quantity?: number; glAccountId?: string; projectId?: string; cc2Id?: string; buId?: string };

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
    SELECT a.account_code AS code, jl.debit, jl.credit, jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id, jl.vat_type
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
    WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${f.fx.companyId}::UUID
    ORDER BY a.account_code, jl.project_id NULLS FIRST, jl.debit, jl.credit`) as Record<string, unknown>[];
  return rows.map((r) => ({
    code: String(r.code), debit: Number(r.debit), credit: Number(r.credit),
    project: r.project_id ? String(r.project_id) : null,
    cc1: r.cc1_id ? String(r.cc1_id) : null,
    cc2: r.cc2_id ? String(r.cc2_id) : null,
    bu: r.bu_id ? String(r.bu_id) : null,
    vat: r.vat_type ? String(r.vat_type) : null,
  }));
}

const journalCount = async () => Number(((await sql`
  SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);

describeIfDisposable('invoice line revenue posting (migration 874)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('posts each line to its own revenue account, job and CC1 / CC2 / BU; AR and VAT unchanged', async () => {
    const { je } = await approved([
      { description: 'TV spot', unitPrice: 10000, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { description: 'Grade', unitPrice: 4000, glAccountId: f.acct.postProduction, projectId: f.project.p1, cc2Id: f.dim.cc2, buId: f.dim.bu },
      { description: 'Admin fee', unitPrice: 1000 },
    ]);
    const p1 = f.project.p1;
    expect(await legs(je)).toEqual([
      L('1100', 17250, 0),
      L('2120', 0, 2250, { vat: 'standard' }),
      L('4000', 0, 1000),
      L('4100', 0, 10000, { project: p1 }),
      L('4200', 0, 4000, { project: p1, cc1: f.dim.fno, cc2: f.dim.cc2, bu: f.dim.bu }),
    ]);
  });

  it('an invoice with no coded line posts the single default_revenue leg, as before', async () => {
    const { je } = await approved([{ description: 'A', unitPrice: 600 }, { description: 'B', unitPrice: 400 }]);
    expect(await legs(je)).toEqual([L('1100', 1150, 0), L('2120', 0, 150, { vat: 'standard' }), L('4000', 0, 1000)]);
  });

  it('the customer\'s FNO tags every revenue leg — the one uncoded leg too — and never AR or VAT', async () => {
    await sql`UPDATE customers SET default_cc1_id = ${f.dim.fno}::UUID WHERE id = ${f.fx.customerId}::UUID`;
    try {
      const plain = await approved([{ description: 'A', unitPrice: 1000 }]);
      expect(await legs(plain.je)).toEqual([L('1100', 1150, 0), L('2120', 0, 150, { vat: 'standard' }), L('4000', 0, 1000, { cc1: f.dim.fno })]);
      const coded = await approved([{ description: 'A', unitPrice: 600, glAccountId: f.acct.commercials }, { description: 'B', unitPrice: 400 }]);
      expect((await legs(coded.je)).filter((l) => l.code.startsWith('4')))
        .toEqual([L('4000', 0, 400, { cc1: f.dim.fno }), L('4100', 0, 600, { cc1: f.dim.fno })]);
    } finally {
      await sql`UPDATE customers SET default_cc1_id = NULL WHERE id = ${f.fx.customerId}::UUID`;
    }
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
      L('4100', 750, 0, { project: p2 }), L('4200', 250, 0, { project: p2 }),
    ]);
    expect((await legs(await note(3000))).filter((l) => l.code.startsWith('4')).map((l) => l.debit)).toEqual([2250, 750]);
    const report = await inTx(f.fx, () => getProjectProfitability(f.fx.companyId, '2026-07-01', '2026-07-31'));
    expect(report.find((r) => r.projectId === p2)?.revenue ?? 0).toBe(0);
  });

  it('an unlinked credit note posts its header job and CC1 / CC2 / BU on its default_revenue debit', async () => {
    const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
      type: 'customer', clientId: f.fx.customerId, creditDate: '2026-07-21', subtotal: 100, taxRate: 0, projectId: f.project.p1,
      cc2Id: f.dim.cc2, buId: f.dim.bu,
    }, f.fx.userId));
    const je = (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId))).glJournalEntryId!;
    expect((await legs(je)).filter((l) => l.code === '4000')).toEqual([
      L('4000', 100, 0, { project: f.project.p1, cc1: f.dim.fno, cc2: f.dim.cc2, bu: f.dim.bu }),
    ]);
  });

  it('cancel reverses every leg, so each project nets to zero', async () => {
    const { id, je } = await approved([
      { description: 'Rental', unitPrice: 500, glAccountId: f.acct.commercials, projectId: f.project.p2, cc2Id: f.dim.cc2 },
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
      expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
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
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((err as Error).message).toMatch(/100\.00.*150\.00.*Re-save the draft/);
    expect(((await sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID`) as { status: string }[])[0]!.status).toBe('draft');
  });

  it.each([
    ['another company\'s account', 'gl_account_id', () => f.acct.foreign, /not in your company/],
    ['another company\'s project', 'project_id', () => f.project.foreign, /not in your company/],
    ['another company\'s CC2 project', 'cc2_id', () => f.dim.foreignCc2, /CC2 must name an active CC2 cost centre in this company/],
  ])('Post to GL refuses a stored line naming %s, before any journal is written', async (_label, column, value, message) => {
    const id = await draft([{ description: 'Forged later', unitPrice: 100 }]);
    // A row no write path accepts — forged as the database would allow it.
    await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    if (column === 'gl_account_id') await sql`UPDATE customer_invoice_items SET gl_account_id = ${value()}::UUID WHERE invoice_id = ${id}::UUID`;
    if (column === 'project_id') await sql`UPDATE customer_invoice_items SET project_id = ${value()}::UUID WHERE invoice_id = ${id}::UUID`;
    if (column === 'cc2_id') await sql`UPDATE customer_invoice_items SET cc2_id = ${value()}::UUID WHERE invoice_id = ${id}::UUID`;
    const before = await journalCount();
    const err = await inTx(f.fx, () => postCustomerInvoiceToGL(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);
    // Past draft an invoice posts its CC1 / CC2 / BU as stored (#675), so another company's CC2 is refused by
    // the journal writer's own cost-centre check (journalCostCentreValidation) — still before any journal row.
    expect(column === 'cc2_id' ? err instanceof Error : err instanceof InvoiceLineCodingRefusal, String(err)).toBe(true);
    expect((err as Error).message).toMatch(message);
    expect(await journalCount()).toBe(before);
  });

  it('past draft, Post to GL posts as stored (#675): coded lines that no longer add up split by weight', async () => {
    const id = await draft([{ description: 'Split', unitPrice: 100, glAccountId: f.acct.commercials }]);
    await sql`UPDATE customer_invoices SET status = 'approved', subtotal = 150, total_amount = 172.5, tax_amount = 22.5 WHERE id = ${id}::UUID`;
    const je = await inTx(f.fx, () => postCustomerInvoiceToGL(f.fx.companyId, id, f.fx.userId));
    expect((await legs(je)).filter((l) => l.code === '4100')).toEqual([L('4100', 0, 150)]);
  });

  it('past draft, a line on an expense account posts as stored; only what the journal refuses is refused first', async () => {
    const id = await draft([{ description: 'Recoded later', unitPrice: 100 }]);
    await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    await sql`UPDATE customer_invoice_items SET gl_account_id = ${f.acct.expense}::UUID WHERE invoice_id = ${id}::UUID`;
    const je = await inTx(f.fx, () => postCustomerInvoiceToGL(f.fx.companyId, id, f.fx.userId));
    expect((await legs(je)).filter((l) => l.code === '6100')).toEqual([L('6100', 0, 100)]);
  });

  it('an FNO is read from the invoice\'s customer in THIS company only (a forged foreign client carries none)', async () => {
    const id = await draft([{ description: 'Forged', unitPrice: 100 }]);
    await sql`UPDATE customers SET default_cc1_id = ${f.dim.foreignCc2}::UUID WHERE id = ${f.other.customerId}::UUID`;
    try {
      await sql`UPDATE customer_invoices SET status = 'approved', client_id = ${f.other.customerId}::UUID,
                customer_id = ${f.other.customerId}::UUID WHERE id = ${id}::UUID`;
      const je = await inTx(f.fx, () => postCustomerInvoiceToGL(f.fx.companyId, id, f.fx.userId));
      expect((await legs(je)).filter((l) => l.code === '4000')).toEqual([L('4000', 0, 100)]);
    } finally {
      await sql`UPDATE customers SET default_cc1_id = NULL WHERE id = ${f.other.customerId}::UUID`;
    }
  });

  it("approve posts the CC1 the line stored at save, not the customer's FNO set since (#675: what was saved and approved posts)", async () => {
    const id = await draft([{ description: 'Job', unitPrice: 100, cc2Id: f.dim.cc2 }]);
    await sql`UPDATE customers SET default_cc1_id = ${f.dim.otherFno}::UUID WHERE id = ${f.fx.customerId}::UUID`;
    try {
      const r = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
      expect((await legs(r.glJournalEntryId!)).filter((l) => l.code === '4000'))
        .toEqual([L('4000', 0, 100, { cc1: f.dim.fno, cc2: f.dim.cc2 })]);
    } finally {
      await sql`UPDATE customers SET default_cc1_id = NULL WHERE id = ${f.fx.customerId}::UUID`;
    }
  });
});
