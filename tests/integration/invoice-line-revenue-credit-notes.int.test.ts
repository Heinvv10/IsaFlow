/**
 * Migration 870, credit notes against coded invoices: the note's revenue legs
 * are decided BEFORE its journal is written — a leg whose account was
 * deactivated since the invoice posted (a year-end clean-up) is debited on
 * default_revenue with its project and cost centre kept, so the note approves
 * and no orphan draft journal is left — and each leg is capped at what the live
 * earlier notes on the same invoice took, the rest untagged. A failure
 * after the journal is written is a 5xx class, so the request rolls back.
 *
 * Disposable databases only (migrations 869 and 870 are not on isaflow_dev).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { assertCreditNoteCanPost } from '@/modules/accounting/services/ar/creditNotePostingChecks';
import { ClosedFiscalPeriodError, InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

async function invoice(items: { unitPrice: number; glAccountId: string; projectId?: string }[]): Promise<string> {
  const { id } = await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 0,
    items: items.map((i) => ({ description: 'Line', ...i })),
  }));
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
}

/** A note against `invoiceId`. Inserted directly when the link validator would refuse it (an over-credit). */
async function note(invoiceId: string, subtotal: number, direct = false): Promise<string> {
  if (!direct) {
    return (await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
      type: 'customer', clientId: f.fx.customerId, customerInvoiceId: invoiceId, creditDate: '2026-07-20', subtotal, taxRate: 0,
    }, f.fx.userId))).id;
  }
  return ((await sql`
    INSERT INTO credit_notes (company_id, type, client_id, customer_invoice_id, credit_date, subtotal, tax_rate,
                              tax_amount, total_amount, status, created_by)
    VALUES (${f.fx.companyId}::UUID, 'customer', ${f.fx.customerId}::UUID, ${invoiceId}::UUID, '2026-07-20',
            ${subtotal}, 0, 0, ${subtotal}, 'draft', ${f.fx.userId}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

async function revenueLegs(journalId: string) {
  return (await sql`
    SELECT a.account_code AS code, jl.debit::float AS debit, jl.project_id AS project
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE jl.journal_entry_id = ${journalId}::UUID AND a.account_type = 'revenue'
    ORDER BY a.account_code, jl.debit`) as { code: string; debit: number; project: string | null }[];
}

const draftCreditJournals = async () => Number(((await sql`
  SELECT COUNT(*) AS n FROM gl_journal_entries
  WHERE company_id = ${f.fx.companyId}::UUID AND source = 'auto_credit_note' AND status = 'draft'`) as { n: string }[])[0]!.n);

describeIfDisposable('credit notes against coded invoices (migration 870)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('a leg whose account was deactivated after the invoice posted falls back to default_revenue, keeping its project', async () => {
    const retired = ((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${f.fx.companyId}::UUID, '4500', 'Old line', 'revenue', 'credit', true) RETURNING id`) as { id: string }[])[0]!.id;
    const inv = await invoice([{ unitPrice: 600, glAccountId: retired, projectId: f.project.p1 },
      { unitPrice: 400, glAccountId: f.acct.commercials }]);
    await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${retired}::UUID`;
    const before = await draftCreditJournals();
    const cnId = await note(inv, 500);
    const je = (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cnId, f.fx.userId))).glJournalEntryId!;
    expect(await revenueLegs(je)).toEqual([
      { code: '4000', debit: 300, project: f.project.p1 },
      { code: '4100', debit: 200, project: null },
    ]);
    expect(await draftCreditJournals()).toBe(before);
  });

  it('a second full note takes nothing more off the legs: it goes wholly to default_revenue, untagged', async () => {
    const inv = await invoice([{ unitPrice: 750, glAccountId: f.acct.commercials, projectId: f.project.p2 },
      { unitPrice: 250, glAccountId: f.acct.postProduction, projectId: f.project.p2 }]);
    const n1 = await note(inv, 1000);
    const j1 = (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, n1, f.fx.userId))).glJournalEntryId!;
    expect(await revenueLegs(j1)).toEqual([
      { code: '4100', debit: 750, project: f.project.p2 }, { code: '4200', debit: 250, project: f.project.p2 },
    ]);
    const n2 = await note(inv, 1000, true);
    const j2 = (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, n2, f.fx.userId))).glJournalEntryId!;
    expect(await revenueLegs(j2)).toEqual([{ code: '4000', debit: 1000, project: null }]);
  });

  it('a cancelled earlier note does not count against the legs', async () => {
    const inv = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    const n1 = await note(inv, 1000, true);
    await inTx(f.fx, () => approveCreditNote(f.fx.companyId, n1, f.fx.userId));
    await sql`UPDATE credit_notes SET status = 'cancelled' WHERE id = ${n1}::UUID`;
    const n2 = await note(inv, 400, true);
    const j2 = (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, n2, f.fx.userId))).glJournalEntryId!;
    expect(await revenueLegs(j2)).toEqual([{ code: '4100', debit: 400, project: f.project.p1 }]);
  });

  it('the inactive-account precheck reads only this company\'s accounts', async () => {
    await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${f.acct.foreign}::UUID`;
    const line = (glAccountId: string) => ({ glAccountId, debit: 1, credit: 0, description: 'x' });
    try {
      // Another company's deactivated account is not this company's to report.
      await expect(inTx(f.fx, () => assertCreditNoteCanPost(f.fx.companyId, '2026-07-20',
        [line(f.acct.commercials), line(f.acct.foreign)]))).resolves.toBeUndefined();
      const err = await inTx(f.fx, () => assertCreditNoteCanPost(f.fx.companyId, '2026-07-20',
        [line(f.acct.inactive), line(f.acct.foreign)])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InactiveAccountError);
      expect((err as InactiveAccountError).accounts).toEqual(['4400']);
    } finally {
      await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${f.acct.foreign}::UUID`;
    }
  });

  it('a closed period, or an AR account deactivated since, is refused BEFORE the journal is written: the 400 commits nothing', async () => {
    const inv = await invoice([{ unitPrice: 100, glAccountId: f.acct.commercials }]);
    const cnId = await note(inv, 100);
    const journals = async () => Number(((await sql`
      SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID AND source = 'auto_credit_note'`) as { n: string }[])[0]!.n);
    const before = await journals();
    // No inTx here: a request that answers 400 COMMITs, so what the refusal wrote would stay.
    const commitAnyway = () => inTx(f.fx, async () => approveCreditNote(f.fx.companyId, cnId, f.fx.userId)
      .catch((e: unknown) => e));
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${f.fx.companyId}::UUID`;
    try {
      expect(await commitAnyway()).toBeInstanceOf(ClosedFiscalPeriodError);
    } finally {
      await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${f.fx.companyId}::UUID`;
    }
    const ar = ((await sql`SELECT id FROM gl_accounts WHERE company_id = ${f.fx.companyId}::UUID AND account_subtype = 'receivable'`) as { id: string }[])[0]!.id;
    await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${ar}::UUID`;
    try {
      expect(await commitAnyway()).toBeInstanceOf(InactiveAccountError);
    } finally {
      await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${ar}::UUID`;
    }
    expect(await journals()).toBe(before);
    expect(((await sql`SELECT status FROM credit_notes WHERE id = ${cnId}::UUID`) as { status: string }[])[0]!.status).toBe('draft');
  });
});
