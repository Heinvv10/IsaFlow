/**
 * Intercompany P2, the worker on the REAL logins production uses: the request pool's login (isaflow_app, which may SET ROLE app_user and
 * holds no table privilege of its own) and the service pool's login (isaflow_service, which inherits app_service, whose policies are
 * USING (true)). The queue runs on the service login (the only one that may call it); every message then runs on the REQUEST login as
 * app_user with the receiver's claims, so that a RESET ROLE inside the receiver's transaction leaves the code with NOTHING: it cannot
 * read another company's books. (On the service login it would read every tenant: that was the defect this guards.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { withReceiverTx } from '../../../src/modules/accounting/services/intercompany/receiverTx';
import { sql } from '../../../src/lib/neon';
import { plantDocument } from './intercompany.helpers';
import { clearMirrorRows, co, connect, mirrorCleanup, mirrorSetup, sentInvoice, U } from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ROLES = ['isaflow_app', 'isaflow_service'];
const original = new Map<string, boolean>();

const loginUrl = (role: string): string => {
  const u = new URL(process.env.DATABASE_URL!);
  u.username = role;
  u.password = `${role}-test-login`;
  return u.toString();
};

beforeAll(async () => {
  await mirrorSetup(pool);
  for (const role of ROLES) {
    original.set(role, (await pool.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [role])).rows[0].rolcanlogin as boolean);
    await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD '${role}-test-login'`);
  }
  // The pools are built on first use, from these: the worker and the routes now connect as production's two logins.
  process.env.DATABASE_URL = loginUrl('isaflow_app');
  process.env.SERVICE_DATABASE_URL = loginUrl('isaflow_service');
}, 60000);
afterAll(async () => {
  for (const role of ROLES) await pool.query(`ALTER ROLE ${role} ${original.get(role) ? 'LOGIN' : 'NOLOGIN'} PASSWORD NULL`).catch(() => undefined);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(() => clearMirrorRows(pool));

describe('the worker on production\'s two logins', () => {
  it('runs end to end: the queue on the service login, the accept as app_user on the request login; a DRAFT bill in B, nothing elsewhere', async () => {
    await connect(pool, { autoAccept: true });
    const { inv, id } = await sentInvoice(pool);
    const beforeOthers = Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id <> $1', [co.B])).rows[0].n);
    expect(await runAutoAccept()).toMatchObject({ considered: 1, accepted: 1, failed: 0, deferred: 0, stuck: 0 });
    const bill = (await pool.query('SELECT * FROM supplier_invoices WHERE company_id = $1', [co.B])).rows[0];
    expect(bill).toMatchObject({ invoice_number: inv.number, status: 'draft' });
    expect((await pool.query('SELECT status, handled_via FROM intercompany_messages WHERE id = $1', [id])).rows[0]).toEqual({ status: 'accepted', handled_via: 'auto' });
    expect(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE company_id <> $1', [co.B])).rows[0].n)).toBe(beforeOthers);
  });

  it('the request login cannot call the queue, and the service login can', async () => {
    const p = await pool.query(`SELECT has_function_privilege('isaflow_app', 'public.intercompany_auto_accept_queue(integer, boolean)', 'EXECUTE') AS app,
                                      has_function_privilege('isaflow_service', 'public.intercompany_auto_accept_queue(integer, boolean)', 'EXECUTE') AS svc`);
    expect(p.rows[0]).toEqual({ app: false, svc: true });
  });

  it('a RESET ROLE inside the receiver\'s transaction leaves the request login with NO table privilege: another company\'s supplier invoices are unreadable', async () => {
    const aBill = await plantDocument(pool, 'supplier_invoice', co.A);
    const inside = await withReceiverTx({ userId: U.b, companyId: co.B }, async () => {
      const as = (await sql`SELECT current_user AS u, session_user AS s`) as Array<Record<string, string>>;
      await sql`RESET ROLE`; // what an injection, or any code path inside the receiver's services, could do
      const after = (await sql`SELECT current_user AS u`) as Array<Record<string, string>>;
      // a SAVEPOINT so the denial does not abort the transaction we are still reading from
      let read: string;
      await sql`SAVEPOINT probe`;
      try {
        const rows = (await sql`SELECT id FROM supplier_invoices WHERE company_id = ${co.A}::UUID`) as unknown[];
        read = `readable:${rows.length}`;
        await sql`RELEASE SAVEPOINT probe`;
      } catch (err) {
        read = `denied:${(err as { code?: string }).code}`;
        await sql`ROLLBACK TO SAVEPOINT probe`;
      }
      return { as: as[0], after: after[0], read };
    });
    expect(inside.as).toEqual({ u: 'app_user', s: 'isaflow_app' });
    expect(inside.after.u).toBe('isaflow_app');
    expect(inside.read).toBe('denied:42501');
    expect(aBill).toBeTruthy();
  });

  it('the same probe on the SERVICE login would read every tenant (why the worker does not run there)', async () => {
    const aBill = await plantDocument(pool, 'supplier_invoice', co.A);
    const service = new Pool({ connectionString: process.env.SERVICE_DATABASE_URL, max: 1 });
    const c = await service.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [co.B]);
      await c.query('RESET ROLE');
      expect((await c.query('SELECT id FROM supplier_invoices WHERE company_id = $1', [co.A])).rows.map((r) => r.id)).toContain(aBill);
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await service.end();
    }
  });
});
