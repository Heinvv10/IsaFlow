/**
 * Review round 2, items 1, 2 and 7: what a credit note may still take off each
 * revenue leg of its invoice is REPLAYED from the earlier notes' amounts, by
 * the leg's identity — not read back from the accounts they posted to, which a
 * deactivation or a reactivation between notes changes — and approvals of
 * notes on one invoice are serialised, so two concurrent approvals cannot both
 * take the same revenue. Per production, revenue never goes below zero.
 *
 * Disposable databases only (migrations 869 and 870 are not on isaflow_dev).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
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
const approve = (id: string) => inTx(f.fx, () => approveCreditNote(f.fx.companyId, id, f.fx.userId));
const setActive = (account: string, active: boolean) => sql`UPDATE gl_accounts SET is_active = ${active} WHERE id = ${account}::UUID`;

/** Revenue left per (project, account) across the invoice and every note journal on it, live ones only. */
async function revenueLeft(inv: string): Promise<Record<string, number>> {
  const rows = (await sql`
    WITH journals AS (
      SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${inv}::UUID
      UNION ALL SELECT gl_journal_entry_id FROM credit_notes WHERE customer_invoice_id = ${inv}::UUID AND status <> 'cancelled'
    )
    SELECT a.account_code AS code, jl.project_id AS project, SUM(jl.credit - jl.debit)::float AS net
    FROM journals j JOIN gl_journal_lines jl ON jl.journal_entry_id = j.je
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE a.account_type = 'revenue' GROUP BY 1, 2`) as { code: string; project: string | null; net: number }[];
  return Object.fromEntries(rows.map((r) => [`${r.code}/${r.project === f.project.p1 ? 'P1' : r.project ?? '-'}`, r.net]));
}
const projectLeft = (left: Record<string, number>, tag: string) =>
  Object.entries(left).filter(([k]) => k.endsWith(`/${tag}`)).reduce((s, [, v]) => s + v, 0);

describeIfDisposable('credit notes replay earlier notes by leg identity, one approval at a time per invoice', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => {
    if (!f) return;
    await setActive(f.acct.commercials, true);
    await dropLineRevenue(f);
  });

  it('a leg deactivated between notes is not credited twice: the production ends at zero, not −300', async () => {
    const inv = await invoice([{ unitPrice: 600, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { unitPrice: 400, glAccountId: f.acct.postProduction }]);
    await approve(await draftNote(inv, 500));
    await setActive(f.acct.commercials, false);
    try {
      await approve(await draftNote(inv, 500));
    } finally {
      await setActive(f.acct.commercials, true);
    }
    const left = await revenueLeft(inv);
    expect(projectLeft(left, 'P1')).toBe(0);
    expect(left['4000/P1']).toBe(-300); // the second note's share, debited where the leg posts now
  });

  it('a leg reactivated between notes is matched by identity too', async () => {
    const inv = await invoice([{ unitPrice: 600, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { unitPrice: 400, glAccountId: f.acct.postProduction }]);
    await setActive(f.acct.commercials, false);
    try {
      await approve(await draftNote(inv, 500));
    } finally {
      await setActive(f.acct.commercials, true);
    }
    await approve(await draftNote(inv, 500));
    const left = await revenueLeft(inv);
    expect(projectLeft(left, 'P1')).toBe(0);
    expect(left['4100/P1']).toBe(300);
    expect(left['4000/P1']).toBe(-300);
  });

  it('a cancelled middle note gives its revenue back to the legs', async () => {
    const inv = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    await approve(await draftNote(inv, 300));
    const middle = await draftNote(inv, 300);
    await approve(middle);
    await inTx(f.fx, () => cancelCreditNote(f.fx.companyId, middle, f.fx.userId, 'issued in error'));
    const last = (await approve(await draftNote(inv, 700))).glJournalEntryId!;
    const legs = (await sql`
      SELECT a.account_code AS code, jl.project_id AS project, jl.debit::float AS debit
      FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
      WHERE jl.journal_entry_id = ${last}::UUID AND a.account_type = 'revenue'`) as Record<string, unknown>[];
    expect(legs).toEqual([{ code: '4100', project: f.project.p1, debit: 700 }]);
  });

  it('two concurrent approvals on one invoice: the second waits, then takes only what is left', async () => {
    const inv = await invoice([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    const n1 = await draftNote(inv, 1000);
    const n2 = await draftNote(inv, 1000);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const [c1, c2] = [await pool.connect(), await pool.connect()];
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await runOn(f.fx, c1, () => approveCreditNote(f.fx.companyId, n1, f.fx.userId));
      let settled = false;
      const second = runOn(f.fx, c2, () => approveCreditNote(f.fx.companyId, n2, f.fx.userId)).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 700));
      expect(settled).toBe(false); // held at the invoice's credit-note lock
      await c1.query('COMMIT');
      await second;
      await c2.query('COMMIT');
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined);
      await c2.query('ROLLBACK').catch(() => undefined);
      c1.release(); c2.release();
      await pool.end();
    }
    const left = await revenueLeft(inv);
    expect(projectLeft(left, 'P1')).toBe(0);
    expect(left['4000/-']).toBe(-1000); // the second note found nothing left on the leg
  });

  it('an over-credit on an uncoded invoice posts one default_revenue line, as master did', async () => {
    const inv = await invoice([{ unitPrice: 1000 }]);
    const id = ((await sql`
      INSERT INTO credit_notes (company_id, type, client_id, customer_invoice_id, credit_date, subtotal, tax_rate,
                                tax_amount, total_amount, status, created_by)
      VALUES (${f.fx.companyId}::UUID, 'customer', ${f.fx.customerId}::UUID, ${inv}::UUID, '2026-07-20', 1500, 0, 0, 1500,
              'draft', ${f.fx.userId}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    const je = (await approve(id)).glJournalEntryId!;
    expect(await sql`
      SELECT jl.debit::float AS debit, jl.project_id FROM gl_journal_lines jl
      JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
      WHERE jl.journal_entry_id = ${je}::UUID AND a.account_type = 'revenue'`).toEqual([{ debit: 1500, project_id: null }]);
  });
});
