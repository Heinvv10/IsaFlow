// tests/integration/drc-vat-export-route.int.test.ts
//
// GET /api/accounting/drc-vat-export read the VAT rate from app_settings with
// no company filter, inside an empty `catch {}`. Until 917 (security_invoker)
// is live, app_settings runs as its owner and returns every company's rows,
// so another company's vat_rate could price this company's export; and a
// failed read was swallowed, after which the next statement died on the
// aborted transaction and the route answered a 400 that named neither.
// Real route on the production logins.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NextApiRequest } from 'next';
import route from '../../pages/api/accounting/drc-vat-export';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const { me, company, other } = ids;
const supplier = crypto.randomUUID();

beforeAll(async () => {
  await setup(ids);
  await fixture.query(`INSERT INTO suppliers (id, company_id, name, company_name) VALUES ($1, $2, 'DRC supplier', 'DRC supplier')`, [supplier, company]);
  await fixture.query(`INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, status,
    total_amount, amount_paid, created_by, is_drc) VALUES ($1, $2, 'DRCX-1', '2026-06-01', '2026-07-01', 'approved', 1000, 0, $3, true)`,
  [company, supplier, me]);
  // Another company prices VAT at 50%: it must never reach this company's export.
  await fixture.query(`INSERT INTO accounting_settings (company_id, key, value) VALUES ($1, 'vat_rate', '0.5')`, [other]);
}, 60000);

afterAll(async () => {
  await fixture.query('DELETE FROM supplier_invoices WHERE company_id = $1', [company]);
  await fixture.query('DELETE FROM suppliers WHERE id = $1', [supplier]);
  await teardown(ids, [getAuthPool(), getDbPool()]);
});

async function exportCsv(): Promise<{ status: number; body: unknown }> {
  const req = request({ 'sb-access-token': await signSession(me, crypto.randomUUID(), 'aal2'), active_company_id: company }, 'GET') as NextApiRequest;
  req.query = {};
  const result = response();
  Object.assign(result.state, { send(b: unknown) { result.state.body = b; return result.state; } });
  await (route as (a: never, b: never) => Promise<unknown>)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body };
}

const vatColumn = (csv: unknown): string => String(csv).split('\n')[1]!.split(',')[4]!;

describe('drc-vat-export: the VAT rate is this company\'s own', () => {
  it('ignores another company\'s vat_rate even where app_settings runs as its owner (before 917 is live)', async () => {
    // Each shard runs one file at a time on its own cluster; still, put back exactly what was there.
    const before = (await fixture.query(`SELECT reloptions FROM pg_class WHERE oid = 'public.app_settings'::regclass`)).rows[0].reloptions as string[] | null;
    await fixture.query('ALTER VIEW public.app_settings SET (security_invoker = false)');
    try {
      const r = await exportCsv();
      expect(r.status).toBe(200);
      expect(vatColumn(r.body)).toBe('150.00');
    } finally {
      await fixture.query(before?.includes('security_invoker=true')
        ? 'ALTER VIEW public.app_settings SET (security_invoker = true)' : 'ALTER VIEW public.app_settings RESET (security_invoker)');
    }
  });

  it('uses this company\'s own vat_rate when it has one', async () => {
    await fixture.query(`INSERT INTO accounting_settings (company_id, key, value) VALUES ($1, 'vat_rate', '0.2')`, [company]);
    try {
      const r = await exportCsv();
      expect(r.status).toBe(200);
      expect(vatColumn(r.body)).toBe('200.00');
      expect(String(r.body).split('\n')[0]).toBe('Invoice,Supplier,Date,Amount (excl),VAT (20%)');
    } finally {
      await fixture.query(`DELETE FROM accounting_settings WHERE company_id = $1 AND key = 'vat_rate'`, [company]);
    }
  });

  it('a failed settings read is not swallowed: 500 naming the real error', async () => {
    const held = (await fixture.query(`SELECT has_table_privilege('app_user', 'public.app_settings', 'SELECT') AS h`)).rows[0].h as boolean;
    expect(held).toBe(true);
    await fixture.query('REVOKE SELECT ON public.app_settings FROM app_user');
    try {
      const r = await exportCsv();
      expect(r).toMatchObject({ status: 500, body: { message: 'permission denied for view app_settings' } });
    } finally {
      await fixture.query('GRANT SELECT ON public.app_settings TO app_user');
    }
  });
});
