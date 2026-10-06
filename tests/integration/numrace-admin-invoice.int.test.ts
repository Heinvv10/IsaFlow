/**
 * NUMRACE: the platform's own billing numbers, INV-YYYYMM-NNNN (admin createInvoice, behind
 * POST /api/admin/billing/invoices). The scope is platform-wide per month.
 *
 * Before the fix two concurrent creates read the same MAX; the second waited on admin_invoices_invoice_number_key
 * and failed 23505, which the route's catch answered 400 "Failed to create invoice". Now createInvoice takes
 * `take_number_lock('INV-YYYYMM-', 864005)` (migration 864) on its transaction before the MAX, so the second
 * waits and mints the next number; a key held past 5 s fails 55P03 and the route answers 503 + Retry-After.
 *
 * Disposable schema fixture only (assertDisposable): the route runs the real withAdmin / withPlatformAdmin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import createInvoiceRoute from '../../pages/api/admin/billing/invoices';
import { createInvoice } from '@/modules/admin/services/invoiceService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';
import { runOn, type Fixture } from './helpers/l1FifoFixture';
import { backendPid, holdKey, settle, waitBlocked } from './helpers/numraceGate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const platformAdmin = crypto.randomUUID();
const companyId = crypto.randomUUID();
const prefix = `INV-${new Date().toISOString().slice(0, 7).replace('-', '')}-`;
const fx = { pool, companyId, userId: platformAdmin } as unknown as Fixture;
const input = (notes: string) => ({ company_id: companyId, subtotal_cents: 100, tax_cents: 15, total_cents: 115, notes });

async function numberOf(id: string): Promise<string> {
  return String((await pool.query('SELECT invoice_number FROM admin_invoices WHERE id = $1', [id])).rows[0].invoice_number);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO companies (id, name, registration_number, created_at) VALUES ($1, $2, $2, NOW())`,
    [companyId, `NUMRACE-A ${companyId}`]);
  await pool.query(`INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'super_admin',true)`,
    [platformAdmin, `${platformAdmin}@test.local`]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [platformAdmin]);
    await pool.query('DELETE FROM admin_invoices WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM users WHERE id=$1', [platformAdmin]);
    await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('NUMRACE: admin billing invoice numbers', () => {
  it('two creates in one month, the second behind the first: both commit, consecutive numbers', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const aPid = await backendPid(a);
      const bPid = await backendPid(b);
      const idA = await runOn(fx, a, () => createInvoice(input('numrace A')));
      const pB = settle(runOn(fx, b, () => createInvoice(input('numrace B'))));
      const blockers = await waitBlocked(pool, bPid).catch(() => [] as number[]);
      await a.query('COMMIT');
      const rB = await pB;
      await b.query(rB.ok ? 'COMMIT' : 'ROLLBACK');
      expect(rB.ok, JSON.stringify(rB)).toBe(true);
      expect(blockers).toContain(aPid);
      const [nA, nB] = [await numberOf(idA), await numberOf(rB.ok ? rB.value : '')];
      expect(nA.startsWith(prefix)).toBe(true);
      expect(Number(nB.slice(prefix.length))).toBe(Number(nA.slice(prefix.length)) + 1);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }, 60000);

  it('the route: the month key held past 5 s -> 503 + Retry-After, nothing written', async () => {
    const held = await holdKey(pool, prefix, 864005);
    const result = response();
    try {
      const jar = { 'sb-access-token': await signSession(platformAdmin, crypto.randomUUID(), 'aal2') };
      const req = request(jar, 'POST') as unknown as { body: unknown; url: string };
      req.body = input('numrace held');
      req.url = '/api/admin/billing/invoices';
      await createInvoiceRoute(req as never, result.res);
    } finally {
      await held.open();
    }
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(503);
    expect(result.state.getHeader('retry-after')).toBe('2');
    const n = (await pool.query("SELECT COUNT(*)::int AS n FROM admin_invoices WHERE company_id=$1 AND notes='numrace held'",
      [companyId])).rows[0].n;
    expect(n).toBe(0);
  }, 60000);
});
