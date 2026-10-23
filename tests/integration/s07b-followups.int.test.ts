// tests/integration/s07b-followups.int.test.ts
//
// S-07b follow-ups (2026-10-23), on the logins production will have:
//   A (918) the service pool can no longer write users.email; change-email and
//       the POPIA erasure write it on the migration_admin pool instead.
//   C (919) app_user no longer reads the AR "last viewed" materialized view
//       (renamed customer_invoice_view_summary_mv), which has no RLS and so
//       held every tenant's counts. The old name is now a security_invoker
//       view over current_company_invoice_view_summary(): today's readers, and
//       code from before 919 after a code-only rollback, see their own
//       company's rows only.
// The migrations themselves: s07b-followups.migration.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import listRoute from '../../pages/api/accounting/customer-invoices-list';
import exportRoute from '../../pages/api/accounting/customer-invoices-export';
import viewsRoute from '../../pages/api/accounting/ar/invoice/[id]/views';
import matviewRoute from '../../pages/api/cron/ar-matview-refresh';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import type { NextApiRequest } from 'next';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';
import { CRON, attempt, callCron, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const { me, company, other } = ids;
const mine = { customer: crypto.randomUUID(), invoice: crypto.randomUUID() };
const theirs = { customer: crypto.randomUUID(), invoice: crypto.randomUUID() };
const asMe = { asRequest: { sub: me, companyId: company } };

beforeAll(async () => {
  await setup(ids);
  for (const [co, x, n] of [[company, mine, 'S07BFU-MINE'], [other, theirs, 'S07BFU-THEIRS']] as const) {
    await fixture.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [x.customer, co, `${n} customer`]);
    await fixture.query(`INSERT INTO customer_invoices (id, company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
      status, total_amount, amount_paid, created_by) VALUES ($1, $2, $3, $3, $4, '2026-06-01', '2026-07-01', 'sent', 100, 0, $5)`,
    [x.invoice, co, x.customer, n, me]);
  }
  // Mine viewed twice, theirs three times: the counts say whose rows came back.
  await fixture.query(`INSERT INTO customer_invoice_views (company_id, customer_invoice_id, view_source)
    VALUES ($1, $2, 'portal'), ($1, $2, 'portal'), ($3, $4, 'portal'), ($3, $4, 'portal'), ($3, $4, 'portal')`,
  [company, mine.invoice, other, theirs.invoice]);
  await fixture.query('REFRESH MATERIALIZED VIEW public.customer_invoice_view_summary_mv');
}, 60000);

afterAll(async () => {
  await fixture.query('DELETE FROM customer_invoice_views WHERE customer_invoice_id = ANY($1)', [[mine.invoice, theirs.invoice]]);
  await fixture.query('DELETE FROM customer_invoices WHERE id = ANY($1)', [[mine.invoice, theirs.invoice]]);
  await fixture.query('DELETE FROM customers WHERE id = ANY($1)', [[mine.customer, theirs.customer]]);
  await fixture.query('REFRESH MATERIALIZED VIEW public.customer_invoice_view_summary_mv');
  await teardown(ids, [getAuthPool(), getDbPool()]);
});

describe('A (918): the service pool cannot write users.email', () => {
  const pool = (): Pool => getDbPool();

  it.each([
    ['email', `UPDATE users SET email = 'taken-over@test.local' WHERE id = $1`],
    ['updated_at', 'UPDATE users SET updated_at = NOW() WHERE id = $1'],
  ])('isaflow_service writing users.%s is refused by privilege', async (_, text) => {
    expect(await attempt(pool(), [[text, [me]]])).toEqual({ code: '42501', message: 'permission denied for table users' });
  });

  it('not with an owner\'s forged claims either', async () => {
    expect(await attempt(pool(), [[`UPDATE users SET email = 'taken-over@test.local' WHERE id = $1`, [me]]],
      { claims: { sub: me, companyId: company } })).toEqual({ code: '42501', message: 'permission denied for table users' });
  });
});

describe('C (919): app_user reads only its own company\'s "last viewed" counts', () => {
  const pool = (): Pool => getAuthPool();

  it('the materialized view itself is refused to a request', async () => {
    expect(await attempt(pool(), [['SELECT view_count FROM customer_invoice_view_summary_mv WHERE company_id = $1', [other]]], asMe))
      .toEqual({ code: '42501', message: 'permission denied for materialized view customer_invoice_view_summary_mv' });
  });

  it('and to the service pool', async () => {
    expect(await attempt(getDbPool(), [['SELECT view_count FROM customer_invoice_view_summary_mv WHERE company_id = $1', [other]]]))
      .toEqual({ code: '42501', message: 'permission denied for materialized view customer_invoice_view_summary_mv' });
  });

  it('the old name (what code from before 919 reads) answers the claimed company\'s rows only', async () => {
    const c = await pool().connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)`,
        [JSON.stringify({ sub: me }), company]);
      // The old readers' own shape: filtered on company_id, here asked for the other tenant's too.
      const r = await c.query(`SELECT customer_invoice_id, view_count::int AS n FROM customer_invoice_view_summary
        WHERE company_id = ANY($1) AND customer_invoice_id = ANY($2)`, [[company, other], [mine.invoice, theirs.invoice]]);
      expect(r.rows).toEqual([{ customer_invoice_id: mine.invoice, n: 2 }]);
    } finally {
      await c.query('ROLLBACK');
      c.release(true);
    }
  });

  it('the wrapper answers the claimed company\'s rows and no other\'s', async () => {
    const c = await pool().connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)`,
        [JSON.stringify({ sub: me }), company]);
      const r = await c.query(`SELECT customer_invoice_id, company_id, view_count::int AS n FROM current_company_invoice_view_summary()
        WHERE customer_invoice_id = ANY($1)`, [[mine.invoice, theirs.invoice]]);
      expect(r.rows).toEqual([{ customer_invoice_id: mine.invoice, company_id: company, n: 2 }]);
    } finally {
      await c.query('ROLLBACK');
      c.release(true);
    }
  });

  it('with no company claimed, the wrapper answers nothing', async () => {
    const r = await getDbPool().query('SELECT count(*)::int AS n FROM current_company_invoice_view_summary()');
    expect(r.rows[0].n).toBe(0);
  });

  it('the AR list still shows last-viewed for its own invoice', async () => {
    const r = await callRoute(listRoute, { sub: me, method: 'GET', companyId: company, query: { q: 'S07BFU-' } });
    expect(r.status).toBe(200);
    const rows = (r.body as { data: { invoices: Array<Record<string, unknown>> } }).data.invoices;
    expect(rows.map((x) => [x.invoice_number, Number(x.view_count), x.last_viewed_at !== null])).toEqual([['S07BFU-MINE', 2, true]]);
  });

  it('the AR export\'s "viewed, unpaid" filter still finds its own viewed invoice, and not the other tenant\'s', async () => {
    const req = request({ 'sb-access-token': await signSession(me, crypto.randomUUID(), 'aal2'), active_company_id: company }, 'GET') as NextApiRequest;
    req.query = { q: 'S07BFU-', aging: 'viewed-unpaid' };
    const result = response();
    Object.assign(result.state, { send(b: unknown) { result.state.body = b; return result.state; } });
    await (exportRoute as (a: never, b: never) => Promise<unknown>)(req as never, result.res as never);
    expect(result.state.statusCode).toBe(200);
    const rows = String(result.state.body).split('\n').slice(1).map((l) => l.split(',')[0]);
    expect(rows).toEqual(['"S07BFU-MINE"']);
  });

  it('the invoice views drawer reads the summary for its own invoice', async () => {
    const r = await callRoute(viewsRoute, { sub: me, method: 'GET', companyId: company, query: { id: mine.invoice } });
    expect(r.status).toBe(200);
    expect((r.body as { data: { summary: Record<string, unknown> } }).data.summary)
      .toMatchObject({ invoiceId: mine.invoice, viewCount: 2, distinctSessions: 0, lastViewedAt: expect.any(String) });
  });

  it('and answers nothing for another company\'s invoice id', async () => {
    const r = await callRoute(viewsRoute, { sub: me, method: 'GET', companyId: company, query: { id: theirs.invoice } });
    expect(r.status).toBe(200);
    expect((r.body as { data: { summary: Record<string, unknown> } }).data.summary).toMatchObject({ viewCount: 0, lastViewedAt: null });
  });

  it('the refresh cron still refreshes the renamed view (service pool, definer wrapper)', async () => {
    await fixture.query(`INSERT INTO customer_invoice_views (company_id, customer_invoice_id, view_source) VALUES ($1, $2, 'portal')`,
      [company, mine.invoice]);
    expect((await callCron(matviewRoute, CRON)).status).toBe(200);
    const r = await fixture.query('SELECT view_count::int AS n FROM customer_invoice_view_summary_mv WHERE customer_invoice_id = $1', [mine.invoice]);
    expect(r.rows).toEqual([{ n: 3 }]);
  });
});
