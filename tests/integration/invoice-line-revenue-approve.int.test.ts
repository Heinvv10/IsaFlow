/**
 * Migration 873, the approve side (review round 1):
 *  - an UNCODED invoice is never refused for its lines — approve and bulk
 *    finalize both post it even when its lines do not add up to the subtotal;
 *  - a CODED invoice whose lines total zero is refused before the status moves;
 *  - bulk finalize posts a coded invoice's split, and its read-only pre-read
 *    (the real `lock: false` path) skips a refused invoice with approve's reason,
 *    dry run and live alike, and reads only this company's invoices;
 *  - the FOR SHARE read really locks the accounts against a concurrent change.
 *
 * Disposable databases only (869 and 873 are not on isaflow_dev).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import {
  invoiceLineCodingRefusal, storedInvoiceLines, storedInvoiceLinesRefusals,
} from '@/modules/accounting/services/ar/invoiceLineCodingGuard';
import { bulkFinalizeInvoicesTool } from '@/lib/mcp/tools/writeBulkFinalizeInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
type Line = { description: string; unitPrice: number; glAccountId?: string; projectId?: string };

const draft = async (items: Line[]) => (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
  clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 0, items,
}))).id;
const status = async (id: string) => ((await sql`SELECT status, gl_journal_entry_id FROM customer_invoices WHERE id = ${id}::UUID`) as
  { status: string; gl_journal_entry_id: string | null }[])[0]!;
const revenue = async (je: string) => (await sql`
  SELECT a.account_code AS code, jl.credit::float AS credit, jl.project_id AS project
  FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
  WHERE jl.journal_entry_id = ${je}::UUID AND a.account_type = 'revenue' ORDER BY a.account_code`) as
  { code: string; credit: number; project: string | null }[];
const finalize = (ids: string[], dry = false) => inTx(f.fx, async () => JSON.parse((await bulkFinalizeInvoicesTool.handler(
  { invoice_ids: ids, idempotency_key: `k-${Math.random()}`, ...(dry ? { dry_run: true } : {}) },
  { companyId: f.fx.companyId, userId: f.fx.userId, scopes: ['write:invoices', 'write:post'], tokenJti: 'j', oauthAppId: null } as McpToolContext,
) as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>);
// The lines of a draft made to disagree with its own subtotal, as a legacy import can leave them.
const skew = (id: string) => sql`UPDATE customer_invoice_items SET amount = amount + 7 WHERE invoice_id = ${id}::UUID`;

describeIfDisposable('approving invoices with and without coded lines (migration 873)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('an uncoded invoice whose lines do not add up is approved, as on master', async () => {
    const id = await draft([{ description: 'A', unitPrice: 100 }]);
    await skew(id);
    const r = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
    expect(await revenue(r.glJournalEntryId!)).toEqual([{ code: '4000', credit: 100, project: null }]);
  });

  it('bulk finalize posts that uncoded invoice too, and a coded one\'s split', async () => {
    const uncoded = await draft([{ description: 'A', unitPrice: 100 }]);
    await skew(uncoded);
    const coded = await draft([{ description: 'B', unitPrice: 60, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { description: 'C', unitPrice: 40 }]);
    const out = await finalize([uncoded, coded]);
    expect(out.posted).toBe(2);
    expect(await revenue(String((await status(coded)).gl_journal_entry_id))).toEqual([
      { code: '4000', credit: 40, project: null }, { code: '4100', credit: 60, project: f.project.p1 },
    ]);
  });

  it('a coded invoice whose lines total zero is refused before the status moves', async () => {
    const id = await draft([{ description: 'Free', unitPrice: 0, glAccountId: f.acct.commercials }]);
    const err = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((err as Error).message).toMatch(/total zero or less/);
    expect(await status(id)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  });

  it('bulk finalize skips a refused invoice with approve\'s reason, in the dry run and live alike', async () => {
    const bad = await draft([{ description: 'Old', unitPrice: 50, glAccountId: f.acct.postProduction }]);
    const good = await draft([{ description: 'New', unitPrice: 50 }]);
    await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${f.acct.postProduction}::UUID`;
    try {
      for (const dry of [true, false]) {
        const out = await finalize([bad, good], dry);
        expect(out.skipped).toEqual([{ index: 0, document_id: bad, reason: expect.stringMatching(/4200 Post-production.*inactive/) }]);
      }
      expect((await status(bad)).status).toBe('draft');
      expect((await status(good)).status).toBe('approved');
    } finally {
      await sql`UPDATE gl_accounts SET is_active = true WHERE id = ${f.acct.postProduction}::UUID`;
    }
  });

  it('the read-only pre-read sees only this company\'s invoices', async () => {
    const theirs = (await sql`
      INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, subtotal, total_amount, created_by, status)
      VALUES (${f.other.companyId}::UUID, 'THEIRS-1', ${f.other.customerId}::UUID, ${f.other.customerId}::UUID, 10, 10, 'system', 'draft')
      RETURNING id`) as { id: string }[];
    await sql`INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, gl_account_id)
              VALUES (${theirs[0]!.id}::UUID, 'x', 1, 10, 10, ${f.acct.expense}::UUID)`;
    expect(await storedInvoiceLines(f.fx.companyId, theirs[0]!.id)).toBeNull();
    expect([...(await storedInvoiceLinesRefusals(f.fx.companyId, [theirs[0]!.id])).keys()]).toEqual([]);
  });

  it('the read-only (lock: false) account read is company-scoped: another company\'s account is foreign to it', async () => {
    expect(await invoiceLineCodingRefusal(f.fx.companyId,
      [{ glAccountId: f.acct.foreign, projectId: null }], { lock: false }))
      .toMatch(/not in your company/);
  });

  it('the FOR SHARE read holds the accounts: a concurrent deactivation waits, and times out', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const holder = await pool.connect();
    const other = await pool.connect();
    try {
      await holder.query('BEGIN');
      await runOn(f.fx, holder, () => invoiceLineCodingRefusal(f.fx.companyId,
        [{ glAccountId: f.acct.commercials, projectId: null }]));
      await other.query('BEGIN');
      await other.query("SET LOCAL lock_timeout = '300ms'");
      const err = await other.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [f.acct.commercials])
        .catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('55P03');
    } finally {
      await other.query('ROLLBACK');
      await holder.query('ROLLBACK');
      other.release(); holder.release();
      await pool.end();
    }
  });
});
