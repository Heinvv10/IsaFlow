// tests/integration/k097-audit-savepoint-adjacent.int.test.ts
//
// K-097 adjacent cases for the savepoint around the admin audit INSERT:
//
//   1. The happy path still writes the audit row and commits — the savepoint
//      must be released, not left open or rolled back.
//   2. A CRITICAL_ACTIONS write whose INSERT fails still throws
//      CriticalAuditError and still raises `criticalAuditFailed`, and the
//      request transaction is left usable so the middleware can roll back
//      deliberately instead of hitting a bare 25P02.
//   3. A second failed audit write in the same request does not compound —
//      each gets its own savepoint and the transaction survives both.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { logAdminAction, CriticalAuditError } from '@/modules/admin/services/auditService';

const DATABASE_URL = process.env.DATABASE_URL;

const ADMIN_USER = randomUUID();
const OK_BUNDLE = `K097 ok ${randomUUID().slice(0, 8)}`;
const CRIT_BUNDLE = `K097 crit ${randomUUID().slice(0, 8)}`;
const TWICE_BUNDLE = `K097 twice ${randomUUID().slice(0, 8)}`;

const BAD_DETAILS = { name: 'pasted' + String.fromCharCode(0) + 'name' };

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-097 audit savepoint adjacent cases', () => {
  let admin: Pool;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM flow_bundles WHERE name = ANY($1)', [[OK_BUNDLE, CRIT_BUNDLE, TWICE_BUNDLE]]);
    await admin.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [ADMIN_USER]);
    await admin.end();
  });

  async function inRequestTx<T>(fn: () => Promise<T>): Promise<{ result: T | null; error: unknown; committed: boolean }> {
    const client: PoolClient = await admin.connect();
    let result: T | null = null;
    let error: unknown = null;
    let committed = false;
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: ADMIN_USER, claims: { sub: ADMIN_USER } }, async () => {
        try {
          result = await fn();
        } catch (err) {
          error = err;
        }
      });
      await client.query('COMMIT');
      committed = true;
    } catch (err) {
      error = error ?? err;
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
    } finally {
      client.release();
    }
    return { result, error, committed };
  }

  it('a successful audit write still commits alongside its mutation', async () => {
    const { error, committed } = await inRequestTx(async () => {
      const rows = (await sql`
        INSERT INTO flow_bundles (name, flows, price_cents, is_active, display_order)
        VALUES (${OK_BUNDLE}, 100, 9900, true, 0)
        RETURNING id
      `) as Array<{ id: string }>;
      await logAdminAction(ADMIN_USER, 'flow.bundle.create', 'flow_bundle', rows[0]!.id, { name: OK_BUNDLE }, '127.0.0.1');
      return rows[0]!.id;
    });

    expect(error).toBeNull();
    expect(committed).toBe(true);

    const bundle = await admin.query('SELECT id FROM flow_bundles WHERE name = $1', [OK_BUNDLE]);
    expect(bundle.rows).toHaveLength(1);
    const audit = await admin.query(
      `SELECT action FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'flow.bundle.create'`,
      [ADMIN_USER],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('a failed CRITICAL audit write throws and leaves the transaction usable', async () => {
    let thrown: unknown = null;
    let criticalFlag: boolean | undefined;
    let readBackAfterFailure: string | null = null;

    const { committed } = await inRequestTx(async () => {
      const rows = (await sql`
        INSERT INTO flow_bundles (name, flows, price_cents, is_active, display_order)
        VALUES (${CRIT_BUNDLE}, 100, 9900, true, 0)
        RETURNING id
      `) as Array<{ id: string }>;

      try {
        await logAdminAction(ADMIN_USER, 'user.suspend', 'user', rows[0]!.id, BAD_DETAILS, '127.0.0.1');
      } catch (err) {
        thrown = err;
      }
      criticalFlag = als.getStore()?.criticalAuditFailed;

      // The whole point: the connection is not poisoned, so the middleware can
      // still query and roll back on purpose rather than blind-firing 25P02.
      const back = (await sql`SELECT name FROM flow_bundles WHERE id = ${rows[0]!.id}`) as Array<{ name: string }>;
      readBackAfterFailure = back[0]?.name ?? null;
      return rows[0]!.id;
    });

    expect(thrown).toBeInstanceOf(CriticalAuditError);
    expect(criticalFlag).toBe(true);
    expect(readBackAfterFailure).toBe(CRIT_BUNDLE);
    expect(committed).toBe(true);
  });

  it('two failed audit writes in one request still leave the mutation intact', async () => {
    const { error, committed } = await inRequestTx(async () => {
      const rows = (await sql`
        INSERT INTO flow_bundles (name, flows, price_cents, is_active, display_order)
        VALUES (${TWICE_BUNDLE}, 100, 9900, true, 0)
        RETURNING id
      `) as Array<{ id: string }>;
      await logAdminAction(ADMIN_USER, 'flow.bundle.create', 'flow_bundle', rows[0]!.id, BAD_DETAILS, '127.0.0.1');
      await logAdminAction(ADMIN_USER, 'flow.bundle.update', 'flow_bundle', rows[0]!.id, BAD_DETAILS, '127.0.0.1');
      return rows[0]!.id;
    });

    expect(error).toBeNull();
    expect(committed).toBe(true);
    const bundle = await admin.query('SELECT id FROM flow_bundles WHERE name = $1', [TWICE_BUNDLE]);
    expect(bundle.rows).toHaveLength(1);
  });
});
