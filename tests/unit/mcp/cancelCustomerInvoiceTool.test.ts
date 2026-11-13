/**
 * cancel_customer_invoice — drafts only (Hein, 2026-11-13). A draft or pending-approval invoice has no journal, so
 * cancelling it is a status flip with no ledger effect. Anything approved (or carrying a journal, a payment or a live
 * allocation) is refused from READS on the locked row, before the cancel runs: the connector has no planner for the
 * reversal an approved cancel posts, so that stays in the app.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCancelService', () => ({ cancelCustomerInvoice: vi.fn() }));

import { sql } from '@/lib/neon';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelCustomerInvoiceTool } from '@/lib/mcp/tools/writeCancelCustomerInvoice';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const INV = 'a1a1a1a1-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1', tokenJti: 'jti' } as unknown as McpToolContext;
const KEY = { idempotency_key: 'k-1' };
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

function row(over: Record<string, unknown> = {}) {
  return {
    id: INV, invoice_number: 'INV0000225', status: 'draft', amount_paid: '0.00',
    total_amount: '13957.27', gl_journal_entry_id: null, ...over,
  };
}

/** First sql call = the locked invoice read; second = the live-allocation sum. */
function db(inv: Record<string, unknown> | null, allocated = '0') {
  vi.mocked(sql)
    .mockResolvedValueOnce((inv ? [inv] : []) as never)
    .mockResolvedValueOnce([{ allocated }] as never);
}

function sqlText(call: number): string {
  return (vi.mocked(sql).mock.calls[call]![0] as unknown as string[]).join('?');
}

beforeEach(() => {
  vi.mocked(sql).mockReset();
  vi.mocked(cancelCustomerInvoice).mockReset();
  vi.mocked(cancelCustomerInvoice).mockResolvedValue({ id: INV, reversedJournalEntryId: null });
});

describe('cancel_customer_invoice', () => {
  it('is a write:invoices tool that posts nothing', () => {
    expect(cancelCustomerInvoiceTool.name).toBe('cancel_customer_invoice');
    expect(cancelCustomerInvoiceTool.scope).toBe('write:invoices');
    expect(cancelCustomerInvoiceTool.write).toBe(true);
    expect(cancelCustomerInvoiceTool.requiresPost).toBeUndefined();
  });

  it('refuses a missing or non-uuid invoice_id before any read', async () => {
    expect(text(await cancelCustomerInvoiceTool.handler({ ...KEY }, ctx))).toBe('invoice_id is required');
    expect((await cancelCustomerInvoiceTool.handler({ invoice_id: 'x', ...KEY }, ctx)).isError).toBe(true);
    expect(sql).not.toHaveBeenCalled();
  });

  it('reads the invoice LOCKED and scoped to the token company, excluding soft-deleted rows', async () => {
    db(row());
    await cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx);
    const q = sqlText(0);
    expect(q).toMatch(/FOR UPDATE/);
    expect(q).toMatch(/company_id = \?::UUID/);
    expect(q).toMatch(/deleted_at IS NULL/);
    expect(vi.mocked(sql).mock.calls[0]).toContain(COMPANY);
    expect(vi.mocked(sql).mock.calls[1]).toContain(COMPANY);
  });

  it('answers a missing or foreign invoice as Not found and never cancels', async () => {
    db(null);
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx);
    expect(text(r)).toBe('Not found');
    expect(cancelCustomerInvoice).not.toHaveBeenCalled();
  });

  it.each(['approved', 'sent', 'overdue', 'partially_paid', 'paid'])('refuses a %s invoice and points to the app', async (status) => {
    db(row({ status }));
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(status);
    expect(text(r)).toMatch(/in the app/);
    expect(cancelCustomerInvoice).not.toHaveBeenCalled();
  });

  it('refuses an already-cancelled invoice', async () => {
    db(row({ status: 'cancelled' }));
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx);
    expect(text(r)).toMatch(/already cancelled/);
    expect(cancelCustomerInvoice).not.toHaveBeenCalled();
  });

  it('refuses a draft that still carries a journal (the cancel would reverse it)', async () => {
    db(row({ gl_journal_entry_id: 'je-1' }));
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/journal/);
    expect(cancelCustomerInvoice).not.toHaveBeenCalled();
  });

  it('refuses a draft with money paid against it', async () => {
    db(row({ amount_paid: '10.00' }));
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/payment/);
    expect(cancelCustomerInvoice).not.toHaveBeenCalled();
  });

  it('refuses a draft a live payment allocation still points at', async () => {
    db(row(), '50.00');
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/payment/);
    expect(sqlText(1)).toMatch(/status <> 'cancelled'/);
    expect(cancelCustomerInvoice).not.toHaveBeenCalled();
  });

  it('dry_run previews the cancel, writes nothing and keeps the idempotency key free', async () => {
    db(row());
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, dry_run: true, ...KEY }, ctx);
    expect(cancelCustomerInvoice).not.toHaveBeenCalled();
    expect((r as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    const body = JSON.parse(text(r));
    // A draft is in no balance (AR counts approved invoices only), so nothing posts and no balance moves.
    expect(body).toMatchObject({ dryRun: true, journals: [], effects: [], journalsTotal: 0 });
    expect(body).toMatchObject({ invoice_id: INV, status_before: 'draft', status_after: 'cancelled' });
  });

  it('dry_run runs the same refusals as the live call', async () => {
    db(row({ status: 'approved' }));
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, dry_run: true, ...KEY }, ctx);
    expect(r.isError).toBe(true);
  });

  it.each(['draft', 'pending_approval'])('cancels a %s invoice through the service and reports it', async (status) => {
    db(row({ status }));
    const r = await cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx);
    expect(cancelCustomerInvoice).toHaveBeenCalledWith(COMPANY, INV, 'u-1');
    expect(JSON.parse(text(r))).toMatchObject({
      invoice_id: INV, invoice_number: 'INV0000225', status_before: status, status: 'cancelled',
    });
  });

  it('rethrows a service failure (no catch around the write)', async () => {
    db(row());
    vi.mocked(cancelCustomerInvoice).mockRejectedValue(new Error('connection reset'));
    await expect(cancelCustomerInvoiceTool.handler({ invoice_id: INV, ...KEY }, ctx)).rejects.toThrow('connection reset');
  });
});
