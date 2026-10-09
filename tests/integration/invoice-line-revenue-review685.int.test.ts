/**
 * PR #685 review round 1:
 *
 * - Approve refuses, BEFORE the status moves, everything posting would refuse
 *   after it: a line saved without the FNO its customer now has (#675's rule),
 *   coded or not — and bulk finalize's dry run skips it with that reason.
 * - Past draft, Post to GL refuses only what the journal itself would: an
 *   inactive account, before any journal row.
 * - A draft edit does not re-check a coding the draft already stores (an
 *   account deactivated since): the save goes through; approve refuses it.
 * - A note unlinked at approval and applied to an invoice later records an
 *   excess row, so the next note on that invoice is not crowded off its legs
 *   by a replay of it.
 * - Credit-note legs are the invoice's journal lines: a re-tag of one of two
 *   lines that shared their tags does not reopen what an earlier note took.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { editDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceDraftEdit';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { bulkFinalizeInvoicesTool } from '@/lib/mcp/tools/writeBulkFinalizeInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
type Item = { description?: string; unitPrice: number; glAccountId?: string; projectId?: string };

const draft = async (items: Item[]) => (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
  clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 0, items: items.map((i) => ({ description: 'Line', ...i })),
}))).id;
const approveInvoice = (id: string) => inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
const statusOf = async (id: string) => ((await sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID`) as { status: string }[])[0]!.status;
const journalCount = async () => Number(((await sql`SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);
const finalizeDry = (ids: string[]) => inTx(f.fx, async () => JSON.parse((await bulkFinalizeInvoicesTool.handler(
  { invoice_ids: ids, idempotency_key: `k-${Math.random()}`, dry_run: true },
  { companyId: f.fx.companyId, userId: f.fx.userId, scopes: ['write:invoices', 'write:post'], tokenJti: 'j', oauthAppId: null } as McpToolContext,
) as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>);
const note = async (subtotal: number, customerInvoiceId?: string) => {
  const { id } = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: f.fx.customerId, ...(customerInvoiceId ? { customerInvoiceId } : {}),
    creditDate: '2026-07-20', subtotal, taxRate: 0,
  }, f.fx.userId));
  await inTx(f.fx, () => approveCreditNote(f.fx.companyId, id, f.fx.userId, { autoApply: 'none' }));
  return id;
};
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

describeIfDisposable('PR #685 review round 1', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('approve refuses an uncoded line saved without the FNO its customer now has, before the status moves; bulk dry run skips it', async () => {
    const id = await draft([{ unitPrice: 100 }]);
    await sql`UPDATE customers SET default_cc1_id = ${f.dim.fno}::UUID WHERE id = ${f.fx.customerId}::UUID`;
    try {
      const err = await approveInvoice(id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
      expect((err as Error).message).toMatch(/customer's FNO.*Re-save the draft/);
      expect(await statusOf(id)).toBe('draft');
      expect((await finalizeDry([id])).skipped).toEqual([{ index: 0, document_id: id, reason: expect.stringMatching(/customer's FNO/) }]);
    } finally {
      await sql`UPDATE customers SET default_cc1_id = NULL WHERE id = ${f.fx.customerId}::UUID`;
    }
  });

  it('an invoice on one dimension group (every line on the customer FNO) approves though its lines do not add up', async () => {
    await sql`UPDATE customers SET default_cc1_id = ${f.dim.fno}::UUID WHERE id = ${f.fx.customerId}::UUID`;
    try {
      const id = await draft([{ unitPrice: 100 }]);
      await sql`UPDATE customer_invoice_items SET amount = amount + 7 WHERE invoice_id = ${id}::UUID`; // a legacy import's skew
      const r = await approveInvoice(id);
      const rev = (await sql`SELECT jl.credit::float AS credit, jl.cc1_id FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
        WHERE jl.journal_entry_id = ${r.glJournalEntryId}::UUID AND a.account_type = 'revenue'`) as { credit: number; cc1_id: string }[];
      expect(rev).toEqual([{ credit: 100, cc1_id: f.dim.fno }]);
    } finally {
      await sql`UPDATE customers SET default_cc1_id = NULL WHERE id = ${f.fx.customerId}::UUID`;
    }
  });

  it('past draft, Post to GL refuses an inactive account before any journal row (the journal would refuse it)', async () => {
    const id = await draft([{ unitPrice: 100 }]);
    await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    await sql`UPDATE customer_invoice_items SET gl_account_id = ${f.acct.inactive}::UUID WHERE invoice_id = ${id}::UUID`;
    const before = await journalCount();
    const err = await inTx(f.fx, () => postCustomerInvoiceToGL(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((err as Error).message).toMatch(/4400 Retired line.*: it is inactive/);
    expect(await journalCount()).toBe(before);
  });

  it('a draft edit saves a coding it already stores though the account was deactivated since; approve refuses it', async () => {
    const id = await draft([{ unitPrice: 100, glAccountId: f.acct.postProduction }]);
    await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${f.acct.postProduction}::UUID`;
    try {
      const saved = await inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
        id, notes: 'still a draft', items: [{ description: 'Line', quantity: 1, unitPrice: 100, glAccountId: f.acct.postProduction }],
      } as never));
      expect(saved).toEqual({ kind: 'ok' });
      expect(await approveInvoice(id).catch((e: unknown) => e)).toBeInstanceOf(InvoiceLineCodingRefusal);
    } finally {
      await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${f.acct.postProduction}::UUID`;
    }
  });

  it('a note unlinked at approval and applied later is not replayed against the invoice it was applied to', async () => {
    const inv = await draft([{ unitPrice: 1000, glAccountId: f.acct.commercials, projectId: f.project.p1 }]);
    await approveInvoice(inv);
    const unlinked = await note(300);
    await inTx(f.fx, () => applyCreditNoteToInvoice(f.fx.companyId, unlinked, inv, f.fx.userId));
    const linked = await note(1000, inv);
    // The unlinked note debited default_revenue; it took nothing off P1, so P1 still carries all 1000.
    expect(await noteLegs(linked)).toEqual({ '4100/P1': 1000 });
  });

  it('a re-tag of one of two lines that shared their tags does not reopen what an earlier note took', async () => {
    const inv = await draft([{ unitPrice: 500, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { unitPrice: 500, glAccountId: f.acct.commercials, projectId: f.project.p2 }]);
    await approveInvoice(inv);
    const lineOn = async (project: string) => ((await sql`
      SELECT jl.id FROM customer_invoices ci JOIN gl_journal_lines jl ON jl.journal_entry_id = ci.gl_journal_entry_id
      WHERE ci.id = ${inv}::UUID AND jl.project_id = ${project}::UUID`) as { id: string }[])[0]!.id;
    const second = await lineOn(f.project.p2);
    await sql`UPDATE gl_journal_lines SET project_id = ${f.project.p1}::UUID WHERE id = ${second}::UUID`; // two lines, one leg's tags
    await note(1000, inv);
    await sql`UPDATE gl_journal_lines SET project_id = ${f.project.p2}::UUID WHERE id = ${second}::UUID`; // re-tagged apart
    // Both lines were fully taken; a second note finds no leg capacity and goes to default_revenue.
    expect(await noteLegs(await note(500, inv))).toEqual({ '4000/-': 500 });
  });
});
