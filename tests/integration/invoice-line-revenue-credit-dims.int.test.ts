/**
 * Migration 873 with 870's dimensions: a LINKED customer credit note reverses
 * the invoice journal's legs on all five tags (account, job, CC1, CC2, BU),
 * records them, and follows a dimension re-tag of the invoice line; its own
 * header tags are refused (CREDIT_NOTE_DIMENSIONS_REFUSED) at create and at
 * approve, before anything is written. An UNLINKED note's header job must be
 * this company's and not cancelled.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { CreditNoteDimensionRefusal } from '@/modules/accounting/services/ar/creditNoteHeaderTags';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

async function invoice(items: Record<string, unknown>[]): Promise<{ id: string; je: string }> {
  const { id } = await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 0,
    items: items.map((i) => ({ description: 'Line', ...i })) as never,
  }));
  const r = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return { id, je: r.glJournalEntryId! };
}
const note = (input: Record<string, unknown>) => inTx(f.fx, () => createCreditNote(f.fx.companyId, {
  type: 'customer', clientId: f.fx.customerId, creditDate: '2026-07-20', taxRate: 0, ...input,
} as never, f.fx.userId));
const approve = (id: string) => inTx(f.fx, () => approveCreditNote(f.fx.companyId, id, f.fx.userId));
/** A draft inserted as rows written before 873 can be: a header tag the create path now refuses. */
const forgedDraft = async (cols: { invoice?: string | null; project?: string | null; cc2?: string | null }) => ((await sql`
  INSERT INTO credit_notes (company_id, type, client_id, customer_invoice_id, credit_date, subtotal, tax_rate, tax_amount,
                            total_amount, status, created_by, project_id, cc2_id)
  VALUES (${f.fx.companyId}::UUID, 'customer', ${f.fx.customerId}::UUID, ${cols.invoice ?? null}::UUID, '2026-07-20', 100, 0, 0,
          100, 'draft', ${f.fx.userId}::UUID, ${cols.project ?? null}::UUID, ${cols.cc2 ?? null}::UUID)
  RETURNING id`) as { id: string }[])[0]!.id;
const journals = async () => Number(((await sql`
  SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);
const notes = async () => Number(((await sql`
  SELECT COUNT(*) AS n FROM credit_notes WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);

async function revenueDebits(je: string) {
  return (await sql`
    SELECT a.account_code AS code, jl.project_id AS project, jl.cc1_id AS cc1, jl.cc2_id AS cc2, jl.bu_id AS bu,
           jl.debit::float AS debit
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE jl.journal_entry_id = ${je}::UUID AND a.account_type = 'revenue'
    ORDER BY a.account_code, jl.debit`) as Record<string, unknown>[];
}

describeIfDisposable('credit notes and the five revenue tags (migrations 870 + 873)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('a linked note debits each invoice leg on its job, CC1, CC2 and BU, and records them', async () => {
    const inv = await invoice([
      { unitPrice: 600, glAccountId: f.acct.commercials, projectId: f.project.p1, cc2Id: f.dim.cc2, buId: f.dim.bu },
      { unitPrice: 400, glAccountId: f.acct.postProduction },
    ]);
    const cn = await approve((await note({ customerInvoiceId: inv.id, subtotal: 500 })).id);
    expect(await revenueDebits(cn.glJournalEntryId!)).toEqual([
      { code: '4100', project: f.project.p1, cc1: f.dim.fno, cc2: f.dim.cc2, bu: f.dim.bu, debit: 300 },
      { code: '4200', project: null, cc1: null, cc2: null, bu: null, debit: 200 },
    ]);
    expect(await sql`
      SELECT project_id, cc1_id, cc2_id, bu_id, amount::float AS amount FROM credit_note_revenue_allocations
      WHERE company_id = ${f.fx.companyId}::UUID AND credit_note_id = ${cn.id}::UUID ORDER BY amount DESC`).toEqual([
      { project_id: f.project.p1, cc1_id: f.dim.fno, cc2_id: f.dim.cc2, bu_id: f.dim.bu, amount: 300 },
      { project_id: null, cc1_id: null, cc2_id: null, bu_id: null, amount: 200 },
    ]);
  });

  it('a dimension re-tag of the invoice line (as tag_journal_lines does) carries the recorded take with it', async () => {
    const inv = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, cc2Id: f.dim.cc2 }]);
    await approve((await note({ customerInvoiceId: inv.id, subtotal: 600 })).id);
    await sql`UPDATE gl_journal_lines SET cc1_id = ${f.dim.otherFno}::UUID, cc2_id = ${f.dim.otherCc2}::UUID
              WHERE journal_entry_id = ${inv.je}::UUID AND company_id = ${f.fx.companyId}::UUID AND cc2_id IS NOT NULL`;
    const n2 = await approve((await note({ customerInvoiceId: inv.id, subtotal: 1000 })).id);
    expect(await revenueDebits(n2.glJournalEntryId!)).toEqual([
      { code: '4000', project: null, cc1: null, cc2: null, bu: null, debit: 600 },
      { code: '4100', project: null, cc1: f.dim.otherFno, cc2: f.dim.otherCc2, bu: null, debit: 400 },
    ]);
  });

  it('a linked note naming its own job or CC1 / CC2 / BU is refused at create, writing nothing', async () => {
    const inv = await invoice([{ unitPrice: 100, glAccountId: f.acct.commercials }]);
    for (const header of [{ projectId: f.project.p1 }, { cc2Id: f.dim.cc2 }, { buId: f.dim.bu }]) {
      const before = await notes();
      const err = await note({ customerInvoiceId: inv.id, subtotal: 50, ...header }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CreditNoteDimensionRefusal);
      expect((err as CreditNoteDimensionRefusal).code).toBe('CREDIT_NOTE_DIMENSIONS_REFUSED');
      expect(await notes()).toBe(before);
    }
  });

  it('a stored linked draft carrying a header tag is refused at approve, before any journal', async () => {
    const inv = await invoice([{ unitPrice: 100, glAccountId: f.acct.commercials }]);
    for (const cols of [{ project: f.project.p1 }, { cc2: f.dim.cc2 }]) {
      const id = await forgedDraft({ invoice: inv.id, ...cols });
      const before = await journals();
      await expect(approve(id)).rejects.toBeInstanceOf(CreditNoteDimensionRefusal);
      expect(await journals()).toBe(before);
    }
  });

  it('an unlinked note\'s job must be this company\'s and not cancelled — at create and again at approve', async () => {
    await expect(note({ subtotal: 50, projectId: f.project.foreign })).rejects.toThrow(/job that is not in your company/);
    await expect(note({ subtotal: 50, projectId: f.project.cancelled })).rejects.toThrow(/job P3-.*cancelled/);
    await expect(note({ subtotal: 50, projectId: ['x'] })).rejects.toThrow(/projectId must be a UUID/);
    const id = await forgedDraft({ project: f.project.cancelled });
    const before = await journals();
    await expect(approve(id)).rejects.toThrow(/job P3-.*cancelled/);
    expect(await journals()).toBe(before);
  });
});
