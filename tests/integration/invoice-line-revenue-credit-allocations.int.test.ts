/**
 * Final review round, item 1: what a credit note took off each revenue leg of
 * its invoice is RECORDED (credit_note_revenue_allocations, migration 874), and
 * the next note's capacity is the leg less what the live notes recorded. A
 * replay of the earlier notes' amounts assumed every live note took its
 * pro-rata share — wrong once a note that went to default_revenue survives the
 * cancellation of the one that filled the leg. Notes approved before 874 have
 * no rows and are still replayed; that is the fallback only.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { repointMovableLines } from '@/modules/accounting/services/gl/accountMergeService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

async function invoice(items: { unitPrice: number; glAccountId?: string; projectId?: string }[]): Promise<string> {
  const { id } = await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 0, items: items.map((i) => ({ description: 'Line', ...i })),
  }));
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
}
const draftNote = async (inv: string, subtotal: number) => (await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
  type: 'customer', clientId: f.fx.customerId, customerInvoiceId: inv, creditDate: '2026-07-20', subtotal, taxRate: 0,
}, f.fx.userId))).id;
const approve = async (id: string) => { await inTx(f.fx, () => approveCreditNote(f.fx.companyId, id, f.fx.userId)); return id; };
const cancel = (id: string) => inTx(f.fx, () => cancelCreditNote(f.fx.companyId, id, f.fx.userId, 'issued in error'));

/** A note's revenue debits, `code/project` → amount. */
async function noteLegs(id: string): Promise<Record<string, number>> {
  const rows = (await sql`
    SELECT a.account_code AS code, jl.project_id AS project, SUM(jl.debit - jl.credit)::float AS debit
    FROM credit_notes cn JOIN gl_journal_lines jl ON jl.journal_entry_id = cn.gl_journal_entry_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE cn.id = ${id}::UUID AND a.account_type = 'revenue' GROUP BY 1, 2`) as { code: string; project: string | null; debit: number }[];
  const tag = (p: string | null) => (p === f.project.p1 ? 'P1' : p === f.project.p2 ? 'P2' : p ?? '-');
  return Object.fromEntries(rows.map((r) => [`${r.code}/${tag(r.project)}`, r.debit]));
}

/** Revenue left on project P1 across the invoice and its live notes. */
async function p1Left(inv: string): Promise<number> {
  const rows = (await sql`
    WITH journals AS (
      SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${inv}::UUID
      UNION ALL SELECT gl_journal_entry_id FROM credit_notes WHERE customer_invoice_id = ${inv}::UUID AND status <> 'cancelled'
    )
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::float AS net
    FROM journals j JOIN gl_journal_lines jl ON jl.journal_entry_id = j.je
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE a.account_type = 'revenue' AND jl.project_id = ${f.project.p1}::UUID`) as { net: number }[];
  return rows[0]!.net;
}

describeIfDisposable('credit notes take capacity from recorded allocations, not a replay', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('records each leg it took and its excess, in the approval', async () => {
    const inv = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    const n1 = await approve(await draftNote(inv, 1000));
    const n2 = await approve(await draftNote(inv, 1000));
    const rows = await sql`
      SELECT credit_note_id, gl_account_id, project_id, amount::float AS amount, is_excess,
             journal_line_id IS NOT NULL AS has_line
      FROM credit_note_revenue_allocations WHERE company_id = ${f.fx.companyId}::UUID AND invoice_id = ${inv}::UUID
      ORDER BY created_at, is_excess`;
    expect(rows).toEqual([
      { credit_note_id: n1, gl_account_id: f.acct.commercials, project_id: f.project.p1, amount: 1000, is_excess: false, has_line: true },
      { credit_note_id: n2, gl_account_id: f.acct.defaultRevenue, project_id: null, amount: 1000, is_excess: true, has_line: false },
    ]);
  });

  it('cancel FIRST: the note that filled the leg is cancelled, the next one takes the leg again', async () => {
    const inv = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    const n1 = await approve(await draftNote(inv, 1000));
    await approve(await draftNote(inv, 1000)); // the leg is full: default_revenue
    await cancel(n1);
    expect(await p1Left(inv)).toBe(1000);
    const n3 = await approve(await draftNote(inv, 1000));
    expect(await noteLegs(n3)).toEqual({ '4100/P1': 1000 });
    expect(await p1Left(inv)).toBe(0);
  });

  it('cancel SECOND: the note that went to default_revenue is cancelled, the leg stays full', async () => {
    const inv = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    await approve(await draftNote(inv, 1000));
    await cancel(await approve(await draftNote(inv, 1000)));
    const n3 = await approve(await draftNote(inv, 1000));
    expect(await noteLegs(n3)).toEqual({ '4000/-': 1000 });
    expect(await p1Left(inv)).toBe(0);
  });

  it('a note approved before 874 (no rows) is replayed, a recorded one is read', async () => {
    const inv = await invoice([{ unitPrice: 600, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { unitPrice: 400, glAccountId: f.acct.postProduction }]);
    const legacy = await approve(await draftNote(inv, 500));
    await sql`DELETE FROM credit_note_revenue_allocations WHERE credit_note_id = ${legacy}::UUID`; // as before 874
    const recorded = await approve(await draftNote(inv, 300));
    expect(await noteLegs(recorded)).toEqual({ '4100/P1': 180, '4200/-': 120 });
    const last = await approve(await draftNote(inv, 400));
    // Left after the replayed 300/200 and the recorded 180/120: 120 on P1, 80 on 4200, 200 over.
    expect(await noteLegs(last)).toEqual({ '4100/P1': 120, '4200/-': 80, '4000/-': 200 });
    expect(await p1Left(inv)).toBe(0);
  });

  it('pre-874 notes replay in APPROVAL order, not creation order (two unequal notes, uneven legs)', async () => {
    const inv = await invoice([{ unitPrice: 0.33, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { unitPrice: 0.25, glAccountId: f.acct.postProduction }, { unitPrice: 0.01, glAccountId: f.acct.commercials, projectId: f.project.p2 }]);
    const small = await approve(await draftNote(inv, 0.05));
    const large = await approve(await draftNote(inv, 0.29));
    await sql`DELETE FROM credit_note_revenue_allocations WHERE credit_note_id IN (${small}::UUID, ${large}::UUID)`;
    // Approved large-then-small: the order the replay must follow (swapped, it leaves P2 untouched — see the unit test).
    await sql`UPDATE credit_notes SET approved_at = NOW() - INTERVAL '2 days' WHERE id = ${large}::UUID`;
    await sql`UPDATE credit_notes SET approved_at = NOW() - INTERVAL '1 day' WHERE id = ${small}::UUID`;
    const n3 = await approve(await draftNote(inv, 0.33));
    expect(await noteLegs(n3)).toEqual({ '4100/P1': 0.13, '4200/-': 0.11, '4100/P2': 0.01, '4000/-': 0.08 });
  });

  it('a merge that moves the invoice journal line carries the recorded take with it', async () => {
    const inv = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    await approve(await draftNote(inv, 600));
    await inTx(f.fx, () => repointMovableLines(f.fx.companyId, f.acct.commercials, f.acct.postProduction));
    const n2 = await approve(await draftNote(inv, 1000));
    expect(await noteLegs(n2)).toEqual({ '4200/P1': 400, '4000/-': 600 });
    expect(await p1Left(inv)).toBe(0);
  });
});
