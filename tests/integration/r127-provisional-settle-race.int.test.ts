// R-127 — two approvals racing for ONE evidenced provisional.
//
// Two supplier invoices carry the same slip. Approved concurrently, both read
// the provisional as unclaimed unless the claim is serialised: each would post a
// reclass and a payment, the bank line would pay two bills, and AP would be
// debited twice for one outflow. The window is opened deterministically: A
// settles and holds its transaction open; B is started and must be seen BLOCKED
// before A commits. B then completes as an ordinary approval — no error, no
// second payment.
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {
  company, invoiceState, pool, seedDoc, seedInvoice, seedProvisional, slipLedger, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inCtx = <T>(c: PoolClient, fn: () => Promise<T>) =>
  als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);

async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const rows = (await pool.query('SELECT pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE pid = $1', [pid]))
      .rows as Array<{ b: number[] }>;
    if ((rows[0]?.b ?? []).length > 0) return;
    await pause(25);
  }
  throw new Error(`backend ${pid} never blocked`);
}

describe('R-127 race: one provisional cannot settle two concurrently approved invoices', () => {
  it('the second approval waits for the first, then approves without reusing the provisional', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 311.10, evidencedBy: doc });
    const first = await seedInvoice({ documentId: doc, totalAmount: 311.10 });
    const second = await seedInvoice({ documentId: doc, totalAmount: 311.10 });

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const bPid = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;

      // A settles the first invoice and keeps its transaction open.
      const approvedA = await inCtx(a, () => approveSupplierInvoice(company, first, user));
      expect(approvedA.status).toBe('paid');

      // B reaches for the same provisional and must wait on A.
      const pendingB = inCtx(b, () => approveSupplierInvoice(company, second, user));
      await waitUntilBlocked(bPid);

      await a.query('COMMIT');
      const approvedB = await pendingB;
      await b.query('COMMIT');

      expect(approvedB.status).toBe('approved');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }

    expect((await invoiceState(first)).status).toBe('paid');
    const inv2 = await invoiceState(second);
    expect(inv2.status).toBe('approved');
    expect(inv2.paid).toBe(0);
    const live = (await pool.query(
      "SELECT COUNT(*)::int AS n FROM supplier_payments WHERE company_id=$1 AND reference=$2 AND status <> 'cancelled'",
      [company, bt],
    )).rows[0].n as number;
    expect(live).toBe(1);
    expect((await slipLedger(je, bt, first)).bank).toBe(-311.10);
  }, 30_000);
});
