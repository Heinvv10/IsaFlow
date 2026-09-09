// tests/integration/k097-audit-log-failure-poisons-admin-tx.int.test.ts
//
// K-097. `logAdminAction` catches every failure of its INSERT into
// `admin_audit_log`, logs it, and rethrows for every action outside
// BEST_EFFORT_ACTIONS (which is empty — so, in practice, for all of them).
//
// The audit INSERT runs on the request's own connection — `withPlatformAdmin`
// and `withAdmin` open one transaction per request and `sql` routes through
// the ALS client — and it is not wrapped in a savepoint. A failed statement
// therefore leaves the whole transaction in the aborted state. Postgres
// answers a COMMIT on an aborted transaction with ROLLBACK and no error, so
// the middleware's COMMIT succeeds, the route has already written its 2xx, and
// the admin mutation the request existed to perform is gone.
//
// That is the shape of every admin write: mutate, then log. This test performs
// the mutation, calls the real `logAdminAction` with an INSERT that fails,
// commits the way a route that swallowed the throw would, and asserts the
// mutation survived — i.e. that the savepoint kept the transaction usable and
// the COMMIT was a real COMMIT. Whether the request is ALLOWED to survive an
// unlogged mutation is the separate fail-closed question, asserted here by the
// thrown CriticalAuditError and the criticalAuditFailed flag that make
// withPlatformAdmin roll it back.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { logAdminAction, CriticalAuditError } from '@/modules/admin/services/auditService';

const DATABASE_URL = process.env.DATABASE_URL;

const BUNDLE_NAME = `K097 bundle ${randomUUID().slice(0, 8)}`;
const ADMIN_USER = randomUUID();

// Reprices the wallet bundles every tenant buys. The old allow-list left it
// out, so its audit failure was swallowed; it now fails closed like everything
// else.
const ACTION = 'flow.bundle.create';

// Postgres cannot store a NUL character in jsonb ("unsupported Unicode escape
// sequence"), so this is a real INSERT failure on a real column rather than an
// injected stub. Any other failure of that INSERT — a lock timeout, a
// constraint, a disk error — leaves the transaction in exactly the same state.
const DETAILS_WITH_NUL = { name: 'pasted' + String.fromCharCode(0) + 'name' };

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-097 a swallowed audit-log failure must not discard the admin mutation', () => {
  let admin: Pool;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM flow_bundles WHERE name = $1', [BUNDLE_NAME]);
    await admin.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [ADMIN_USER]);
    await admin.end();
  });

  it('a failed audit INSERT does not silently roll back the mutation it followed', async () => {
    const client: PoolClient = await admin.connect();
    let insertedId: string | undefined;
    let auditThrew: unknown = null;
    let commitThrew: unknown = null;
    let criticalFlag: boolean | undefined;
    let txStillUsable = false;

    try {
      // The middleware's transaction.
      await client.query('BEGIN');

      await als.run(
        { client, userId: ADMIN_USER, claims: { sub: ADMIN_USER } },
        async () => {
          // 1. The admin mutation the request exists to perform.
          const rows = (await sql`
            INSERT INTO flow_bundles (name, flows, price_cents, is_active, display_order)
            VALUES (${BUNDLE_NAME}, 100, 9900, true, 0)
            RETURNING id
          `) as Array<{ id: string }>;
          insertedId = rows[0]!.id;

          // 2. The audit write, which fails.
          try {
            await logAdminAction(
              ADMIN_USER,
              ACTION,
              'flow_bundle',
              insertedId,
              DETAILS_WITH_NUL,
              '127.0.0.1',
            );
          } catch (err) {
            auditThrew = err;
          }
          criticalFlag = als.getStore()?.criticalAuditFailed;

          // 3. The savepoint's whole point: the request transaction is still
          //    usable after the failed INSERT. Without it this raises 25P02.
          const probe = (await sql`SELECT 1 AS ok`) as Array<{ ok: number }>;
          txStillUsable = probe[0]?.ok === 1;
        },
      );

      // 4. The middleware commits. Postgres answers ROLLBACK for a COMMIT on
      //    an aborted transaction, without raising — so a poisoned transaction
      //    would reach this line and look successful.
      await client.query('COMMIT');
    } catch (err) {
      commitThrew = err;
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
    } finally {
      client.release();
    }

    // Fail-closed: the caller IS told, and the flag that drives the
    // middleware's rollback is raised.
    expect(auditThrew).toBeInstanceOf(CriticalAuditError);
    expect(criticalFlag).toBe(true);
    expect(txStillUsable).toBe(true);
    expect(commitThrew).toBeNull();
    expect(insertedId).toBeTruthy();

    // The defect: with the audit INSERT unprotected, the transaction was
    // aborted, this COMMIT was a silent ROLLBACK and the row was gone.
    const { rows } = await admin.query(
      'SELECT id FROM flow_bundles WHERE id = $1',
      [insertedId],
    );
    expect(rows).toHaveLength(1);
  });
});
