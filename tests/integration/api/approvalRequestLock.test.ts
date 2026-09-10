/**
 * lockApprovalRequestForUpdate — the serialisation guarantee, deterministically.
 *
 * K-043 round-6 MEDIUM-2: `decideRequest` computed authority in `assertMayDecide`
 * (one unlocked SELECT) and then issued a separate status-predicated UPDATE.
 * Since `rebindPendingRequest` now writes `rule_id` and `required_role` on
 * pending rows, a concurrent re-request can move a request onto a different rule
 * between those two statements, and the decide still commits — it blocks on the
 * rebind's row lock and re-checks only `status = 'pending'`.
 *
 * Firing a decide and a re-request "at once" would not prove the remedy: the
 * interleaving is timing-dependent and passes with the lock removed. The lock's
 * own contract is what the service depends on, so that is what is pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import {
  lockApprovalRequestForUpdate,
  ApprovalRequestLockTimeoutError,
} from '@/modules/accounting/services/gl/approvalRequestLock';

const COMPANY = '00000000-0000-0000-0000-0000000a0431';
const OTHER = '00000000-0000-0000-0000-0000000a0432';
const USER = '00000000-0000-0000-e2e0-0000000a0431';

let pool: Pool;
let requestA: string;
let requestB: string;
let foreign: string;

async function makeRequest(companyId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO approval_requests (company_id, document_type, document_id, amount, requested_by, required_role)
    VALUES (${companyId}::UUID, 'supplier_invoice', ${crypto.randomUUID()}::UUID, 500000, ${USER}::UUID, 'admin')
    RETURNING id` as { id: string }[];
  return rows[0]!.id;
}

async function begin(): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  return c;
}
function on<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  for (const [id, name] of [[COMPANY, 'K043 Lock Test'], [OTHER, 'K043 Lock Other']] as const) {
    await sql`
      INSERT INTO companies (id, name, created_at) VALUES (${id}::UUID, ${name}, NOW())
      ON CONFLICT (id) DO NOTHING`;
  }
  requestA = await makeRequest(COMPANY);
  requestB = await makeRequest(COMPANY);
  foreign = await makeRequest(OTHER);
});

afterAll(async () => {
  await sql`DELETE FROM approval_requests WHERE company_id IN (${COMPANY}::UUID, ${OTHER}::UUID)`;
  await sql`DELETE FROM companies WHERE id IN (${COMPANY}::UUID, ${OTHER}::UUID)`;
  await pool.end();
});

describe('lockApprovalRequestForUpdate', () => {
  it('refuses to run outside a request transaction', async () => {
    await expect(lockApprovalRequestForUpdate(COMPANY, requestA))
      .rejects.toThrow(/requires a request transaction/);
  });

  it('locks the row a decide is about to authorise against', async () => {
    const client = await begin();
    try {
      await expect(on(client, () => lockApprovalRequestForUpdate(COMPANY, requestA))).resolves.toBeUndefined();
      // The lock is real: a second connection cannot take it without waiting.
      const other = await pool.connect();
      try {
        await other.query('BEGIN');
        await other.query("SET LOCAL lock_timeout = '300ms'");
        await expect(other.query('SELECT id FROM approval_requests WHERE id=$1 FOR UPDATE', [requestA]))
          .rejects.toMatchObject({ code: '55P03' });
      } finally {
        await other.query('ROLLBACK');
        other.release();
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('surfaces a contended row as ApprovalRequestLockTimeoutError, not a hang', async () => {
    const holder = await begin();
    const waiter = await begin();
    try {
      await holder.query('SELECT id FROM approval_requests WHERE id=$1 FOR UPDATE', [requestA]);
      // No lock_timeout is set here on purpose: lockApprovalRequestForUpdate
      // issues its own `SET LOCAL lock_timeout = '5s'` on this very client, so
      // any budget declared by the test is overwritten before the FOR UPDATE.
      // The 5s the code actually applies is what the elapsed assertion pins.
      const startedAt = Date.now();
      const error = await on(waiter, () => lockApprovalRequestForUpdate(COMPANY, requestA))
        .then(() => null, (e: unknown) => e);
      const elapsed = Date.now() - startedAt;
      expect(error).toBeInstanceOf(ApprovalRequestLockTimeoutError);
      expect((error as ApprovalRequestLockTimeoutError).code).toBe('APPROVAL_REQUEST_LOCK_TIMEOUT');
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(9000);
    } finally {
      await waiter.query('ROLLBACK'); waiter.release();
      await holder.query('ROLLBACK'); holder.release();
    }
  });

  it('leaves the transaction USABLE after a timeout, so the 409 is not followed by a 25P02', async () => {
    // 55P03 aborts the Postgres transaction. The route answers the timeout as a
    // 409 and withAuth then COMMITs, so without the savepoint every statement
    // after the caught error — the COMMIT included — raises a bare 25P02.
    const holder = await begin();
    const waiter = await begin();
    try {
      await holder.query('SELECT id FROM approval_requests WHERE id=$1 FOR UPDATE', [requestA]);
      const error = await on(waiter, () => lockApprovalRequestForUpdate(COMPANY, requestA))
        .then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ApprovalRequestLockTimeoutError);
      // The proof: an ordinary read on the SAME client still works.
      const { rows } = await waiter.query('SELECT 1 AS ok');
      expect(rows[0].ok).toBe(1);
      await expect(waiter.query('COMMIT')).resolves.toBeDefined();
    } finally {
      try { await waiter.query('ROLLBACK'); } finally { waiter.release(); }
      await holder.query('ROLLBACK'); holder.release();
    }
  });

  it('never blocks a DIFFERENT request — the lock is per row, not per table', async () => {
    const holder = await begin();
    const waiter = await begin();
    try {
      await holder.query('SELECT id FROM approval_requests WHERE id=$1 FOR UPDATE', [requestA]);
      await expect(on(waiter, () => lockApprovalRequestForUpdate(COMPANY, requestB))).resolves.toBeUndefined();
    } finally {
      await waiter.query('ROLLBACK'); waiter.release();
      await holder.query('ROLLBACK'); holder.release();
    }
  });

  it("locks nothing for another company's request, and does not error", async () => {
    const client = await begin();
    try {
      await expect(on(client, () => lockApprovalRequestForUpdate(COMPANY, foreign))).resolves.toBeUndefined();
      // Proof it took no lock: another connection takes it immediately.
      const other = await pool.connect();
      try {
        await other.query('BEGIN');
        await other.query("SET LOCAL lock_timeout = '300ms'");
        const { rowCount } = await other.query('SELECT id FROM approval_requests WHERE id=$1 FOR UPDATE', [foreign]);
        expect(rowCount).toBe(1);
      } finally {
        await other.query('ROLLBACK');
        other.release();
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
