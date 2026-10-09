/**
 * PR #685 review round 2:
 *
 * - A note already linked to an invoice keeps that link when applied to
 *   another (applyCreditNoteToInvoice): a pre-874 note stays REPLAYED on the
 *   invoice it took from, so that invoice's legs do not reopen, and it records
 *   no excess row where it was applied.
 * - applyCreditNoteToInvoice holds the invoice's credit-note lock (the key
 *   approveCreditNote takes), so an approval of another note on the invoice
 *   cannot read its allocation rows mid-change.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { lockInvoiceCreditNotes } from '@/modules/accounting/services/ar/creditNotePostingChecks';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

const invoice = async (items: { unitPrice: number; glAccountId?: string; projectId?: string }[]) => {
  const { id } = await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 0, items: items.map((i) => ({ description: 'Line', ...i })),
  }));
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
const note = async (subtotal: number, customerInvoiceId?: string) => {
  const { id } = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: f.fx.customerId, ...(customerInvoiceId ? { customerInvoiceId } : {}),
    creditDate: '2026-07-20', subtotal, taxRate: 0,
  }, f.fx.userId));
  await inTx(f.fx, () => approveCreditNote(f.fx.companyId, id, f.fx.userId, { autoApply: 'none' }));
  return id;
};
async function noteLegs(id: string): Promise<Record<string, number>> {
  const rows = (await sql`
    SELECT a.account_code AS code, jl.project_id AS project, SUM(jl.debit - jl.credit)::float AS debit
    FROM credit_notes cn JOIN gl_journal_lines jl ON jl.journal_entry_id = cn.gl_journal_entry_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE cn.id = ${id}::UUID AND a.account_type = 'revenue' GROUP BY 1, 2`) as { code: string; project: string | null; debit: number }[];
  const tag = (p: string | null) => (p === f.project.p1 ? 'P1' : p ?? '-');
  return Object.fromEntries(rows.map((r) => [`${r.code}/${tag(r.project)}`, r.debit]));
}

describeIfDisposable('PR #685 review round 2', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('a pre-874 note linked to X and applied to Y stays linked to, and replayed on, X', async () => {
    const x = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    const y = await invoice([{ unitPrice: 500 }]);
    const n1 = await note(1200, x); // settles X's 1000; 200 left to apply elsewhere
    await sql`DELETE FROM credit_note_revenue_allocations WHERE credit_note_id = ${n1}::UUID`; // as approved before 874
    await inTx(f.fx, () => applyCreditNoteToInvoice(f.fx.companyId, n1, y, f.fx.userId));
    const linked = (await sql`SELECT customer_invoice_id FROM credit_notes WHERE id = ${n1}::UUID`) as { customer_invoice_id: string }[];
    expect(linked[0]!.customer_invoice_id).toBe(x);
    expect((await sql`SELECT 1 FROM credit_note_revenue_allocations WHERE credit_note_id = ${n1}::UUID`).length).toBe(0);
    // n1's 1200 is replayed against X's P1 leg (1000) and fills it, so a later note on X finds nothing there.
    expect(await noteLegs(await note(300, x))).toEqual({ '4000/-': 300 });
  });

  it("holds the invoice's credit-note lock: an approval of another note on it waits, and times out", async () => {
    const x = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    const n1 = await note(100);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const holder = await pool.connect();
    const other = await pool.connect();
    try {
      await holder.query('BEGIN');
      await runOn(f.fx, holder, () => applyCreditNoteToInvoice(f.fx.companyId, n1, x, f.fx.userId));
      await other.query('BEGIN');
      await other.query("SET LOCAL lock_timeout = '300ms'");
      const err = await runOn(f.fx, other, () => lockInvoiceCreditNotes(x)).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('55P03');
    } finally {
      await other.query('ROLLBACK');
      await holder.query('ROLLBACK');
      other.release(); holder.release();
      await pool.end();
    }
  });
});
