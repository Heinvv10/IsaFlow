/**
 * cancel_customer_invoice (drafts only) against a real database: the tool's checks hold because it reads the invoice
 * LOCKED in the same transaction as the cancel. Without that lock, an approval committed between the tool's read and
 * the service's own lock would be cancelled as if it were still a draft.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { cancelCustomerInvoiceTool } from '@/lib/mcp/tools/writeCancelCustomerInvoice';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, runOn, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';
import { backendPid, waitUntilBlocked } from './helpers/lockWait';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
const KEY = { idempotency_key: 'k-int' };
const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti' }) as unknown as McpToolContext;

async function state(id: string): Promise<{ status: string; je: string | null }> {
  const r = ((await sql`
    SELECT status, gl_journal_entry_id FROM customer_invoices
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!;
  return { status: String(r.status), je: r.gl_journal_entry_id == null ? null : String(r.gl_journal_entry_id) };
}

async function journalCount(): Promise<number> {
  return Number(((await sql`
    SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[])[0]!.n);
}

describeIfDb('cancel_customer_invoice — drafts only, over a real database', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test cancels invoices.');
    fx = await seedFixture('CCI', DATABASE_URL!);
  }, 120000);

  afterAll(async () => { await dropFixture(fx); }, 120000);

  it('cancels a draft: status cancelled, no journal written', async () => {
    const id = await seedInvoice(fx, { number: 'D1', date: '2026-05-01', total: 115, status: 'draft' });
    const before = await journalCount();
    const r = await inTx(fx, () => cancelCustomerInvoiceTool.handler({ invoice_id: id, ...KEY }, ctx()));
    expect(r.isError).toBeFalsy();
    expect(await state(id)).toEqual({ status: 'cancelled', je: null });
    expect(await journalCount()).toBe(before);
  });

  it('an approval committed while the tool waits for the row is refused, not cancelled', async () => {
    const id = await seedInvoice(fx, { number: 'D2', date: '2026-05-01', total: 115, status: 'draft' });
    const approver = await fx.pool.connect();
    const canceller = await fx.pool.connect();
    try {
      await approver.query('BEGIN');
      await approver.query(`UPDATE customer_invoices SET status = 'approved' WHERE id = $1`, [id]);

      await canceller.query('BEGIN');
      const pid = await backendPid(canceller);
      const pending = runOn(fx, canceller, () => cancelCustomerInvoiceTool.handler({ invoice_id: id, ...KEY }, ctx()));
      await waitUntilBlocked(fx.pool, pid);
      await approver.query('COMMIT');

      const r = await pending;
      await canceller.query('COMMIT');
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('approved');
      expect((await state(id)).status).toBe('approved');
    } finally {
      await approver.query('ROLLBACK').catch(() => undefined);
      await canceller.query('ROLLBACK').catch(() => undefined);
      approver.release();
      canceller.release();
    }
  }, 30000);

  it('a peer holding the row past the lock budget gets the retry error, and nothing changes', async () => {
    const id = await seedInvoice(fx, { number: 'D3', date: '2026-05-01', total: 115, status: 'draft' });
    const holder = await fx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      await expect(inTx(fx, () => cancelCustomerInvoiceTool.handler({ invoice_id: id, ...KEY }, ctx())))
        .rejects.toThrow(/being changed by another request/);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect((await state(id)).status).toBe('draft');
  }, 30000);
});
