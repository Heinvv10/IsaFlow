/**
 * LINK-REVOKE under concurrency: a second revoke that waited on the invoice lock sees the first
 * one's commit, and the 5s lock timeout answers a retryable 400 and writes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { pool } from './r167-portal-links.helpers';
import { invoice, payNow, tokenOf } from './r177-portal-followups.helpers';
import { revoke, setupRevokeFixture, status, teardownRevokeFixture } from './link-revoke.helpers';

assertDisposable();

beforeAll(setupRevokeFixture);
afterAll(teardownRevokeFixture);

describe('LINK-REVOKE: locking', () => {
  it('two revokes at once: the one that waited on the lock sees the first one\'s commit and answers 404', async () => {
    const id = await invoice();
    await payNow(id);
    const holder = await pool.connect();
    let committed = false;
    let second: ReturnType<typeof revoke> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      second = revoke(id); // blocks on the row lock, its statement snapshot already taken
      second.catch(() => undefined); // an early rejection is reported when it is awaited below
      // Wait until the revoke's locking SELECT is really blocked on a lock: no fixed sleep.
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        waiting = (await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND pg_blocking_pids(pid) @> ARRAY[$1::int] AND query ILIKE '%SELECT ci.payment_url%FOR NO KEY UPDATE%'`,
          [holderPid])).rowCount ?? 0;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(waiting, 'the second revoke never blocked on the invoice lock').toBeGreaterThan(0);
      await holder.query("UPDATE portal_payment_links SET status = 'cancelled' WHERE invoice_id = $1", [id]);
      await holder.query('UPDATE customer_invoices SET payment_url = NULL, online_payment_enabled = false WHERE id = $1', [id]);
      await holder.query('COMMIT');
      committed = true;
      const r = await second;
      expect(r.statusCode).toBe(404);
      expect(r.body.error?.message).toBe('No active payment link');
    } finally {
      if (!committed) await holder.query('ROLLBACK').catch(() => undefined);
      await second?.catch(() => undefined); // the revoke must not outlive the test and race the cleanup
      holder.release();
    }
  });

  it('waits at most 5s for an invoice another request holds, then answers a retryable 400 and writes nothing', async () => {
    const id = await invoice();
    const token = tokenOf(await payNow(id));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      const started = Date.now();
      const r = await revoke(id);
      expect(Date.now() - started).toBeGreaterThan(4000);
      expect(r.statusCode).toBe(400);
      expect(JSON.stringify(r.body)).toContain('CUSTOMER_INVOICE_LOCK_TIMEOUT');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await status(token)).toBe('active');
  }, 20_000);
});
