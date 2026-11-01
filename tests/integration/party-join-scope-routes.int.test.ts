// tests/integration/party-join-scope-routes.int.test.ts
//
// The API routes that read suppliers/customers themselves, on a document of
// company A naming company B's party. Each runs as a member of A through the
// real handler: the row stays, B's name does not. The caller belongs to BOTH
// companies, the one case RLS on suppliers/customers does not cover (a bookkeeper
// on two books); for a member of A alone RLS hides B's party, so an inner join
// used to drop the row instead. The portal route has no session at all.

import { randomBytes } from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import customerAllocations from '../../pages/api/accounting/customer-allocations';
import customerAllocationsExport from '../../pages/api/accounting/customer-allocations-export';
import customerPaymentsExport from '../../pages/api/accounting/customer-payments-export';
import dashboardTodos from '../../pages/api/accounting/dashboard-todos';
import drcVatExport from '../../pages/api/accounting/drc-vat-export';
import portalInvoice from '../../pages/api/portal/invoice/[token]';
import projects from '../../pages/api/accounting/projects';
import purchaseOrder from '../../pages/api/accounting/purchase-orders/[id]';
import purchaseOrders from '../../pages/api/accounting/purchase-orders';
import purchasesBySupplier from '../../pages/api/accounting/reports/purchases-by-supplier';
import supplierAllocations from '../../pages/api/accounting/supplier-allocations';
import supplierReturns from '../../pages/api/accounting/supplier-returns';
import { UNKNOWN_CUSTOMER } from '@/modules/accounting/services/ar/arAgingInvoices';
import { UNKNOWN_SUPPLIER } from '@/modules/accounting/services/ap/apAgingInvoices';
import { getDRCHistory } from '@/modules/accounting/services/reports/drcVatService';
import { AMOUNTS, dropAgingScope, newAgingScope, seedAgingScope } from '../helpers/agingScopeFixture';
import { docNo, dropPartyDocs, seedPartyDocs, type PartyDocs } from '../helpers/partyJoinScopeFixture';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const S = newAgingScope();
const OK_CUSTOMER = `Tenant A Customer ${S.TAG}`;
const OK_SUPPLIER = `Tenant A Supplier ${S.TAG}`;
const tokens: Record<string, string> = {};
let user = '';
let docs: PartyDocs;

beforeAll(async () => {
  await seedAgingScope(pool, S);
  docs = await seedPartyDocs(pool, S);
  user = await createUser(pool, tokens);
  for (const co of [S.A, S.B]) {
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'admin')`, [co, user]);
  }
}, 60000);

afterAll(async () => {
  await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
  await dropPartyDocs(pool, S);
  await dropAgingScope(pool, S);
  await pool.query('DELETE FROM users WHERE id = $1', [user]);
  await pool.end();
}, 60000);

type Route = Parameters<typeof callRoute>[0];
async function get(route: unknown, url: string, query: Record<string, string> = {}): Promise<string> {
  const res = await callRoute(route as Route, tokens[user]!, S.A, 'GET', undefined, url, query);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return JSON.stringify(res.state.body);
}
const cleared = (json: string, marker: string, okName?: string) => {
  expect(json).toContain(marker);
  expect(json).not.toContain(S.LEAK_CUSTOMER);
  expect(json).not.toContain(S.LEAK_SUPPLIER);
  if (okName) expect(json).toContain(okName);
};

describe('API routes keep the row and lose the foreign party', () => {
  it('customer-allocations: all, by payment, by client', async () => {
    const url = '/api/accounting/customer-allocations';
    const all = await get(customerAllocations, url);
    cleared(all, docNo(S, 'CP', 'POISONED'), OK_CUSTOMER);
    expect(all).toContain(UNKNOWN_CUSTOMER);
    cleared(await get(customerAllocations, url, { payment_id: docs.POISONED.customerPayment }), UNKNOWN_CUSTOMER);
    cleared(await get(customerAllocations, url, { client_id: S.CUST_B }), UNKNOWN_CUSTOMER);
  });

  it('customer-allocations-export keeps the line', async () => {
    const csv = await get(customerAllocationsExport, '/api/accounting/customer-allocations-export');
    cleared(csv, docNo(S, 'CP', 'POISONED'), OK_CUSTOMER);
    expect(csv).toContain(UNKNOWN_CUSTOMER);
  });

  it('supplier-allocations: all, by payment, by supplier', async () => {
    await pool.query('UPDATE suppliers SET company_name = name WHERE id = ANY($1)', [[S.SUPP_A, S.SUPP_B]]);
    const url = '/api/accounting/supplier-allocations';
    const names = (json: string) => (JSON.parse(json) as { data: { payment_number: string; supplier_name: string | null }[] }).data
      .map((r) => [r.payment_number, r.supplier_name]);
    const poisoned = [docNo(S, 'SP', 'POISONED'), UNKNOWN_SUPPLIER];
    const all = await get(supplierAllocations, url);
    cleared(all, docNo(S, 'SP', 'POISONED'), OK_SUPPLIER);
    expect(names(all)).toContainEqual(poisoned);
    for (const query of [{ payment_id: docs.POISONED.supplierPayment }, { supplier_id: S.SUPP_B }]) {
      const json = await get(supplierAllocations, url, query);
      cleared(json, docNo(S, 'SP', 'POISONED'));
      expect(names(json)).toEqual([poisoned]);
    }
  });

  it('supplier-allocations: a supplier of this company with no company_name shows its name, not the unknown label', async () => {
    await pool.query('UPDATE suppliers SET company_name = NULL WHERE id = $1', [S.SUPP_A]);
    const url = '/api/accounting/supplier-allocations';
    for (const query of [{}, { payment_id: docs.OK.supplierPayment }, { supplier_id: S.SUPP_A }]) {
      const rows = (JSON.parse(await get(supplierAllocations, url, query)) as { data: { payment_number: string; supplier_name: string | null }[] }).data;
      expect(rows.find((r) => r.payment_number === docNo(S, 'SP', 'OK'))?.supplier_name).toBe(OK_SUPPLIER);
    }
    await pool.query('UPDATE suppliers SET company_name = name WHERE id = $1', [S.SUPP_A]);
  });

  it('drc-vat-export lists what getDRCHistory lists: the foreign bill under UNKNOWN_SUPPLIER, and never "null"', async () => {
    await pool.query('UPDATE supplier_invoices SET is_drc = true WHERE company_id = $1', [S.A]);
    // SUPP_A with no company_name: the column alone printed "null" for a real supplier.
    await pool.query('UPDATE suppliers SET company_name = NULL WHERE id = $1', [S.SUPP_A]);
    await pool.query('UPDATE suppliers SET company_name = name WHERE id = $1', [S.SUPP_B]);
    const csv = JSON.parse(await get(drcVatExport, '/api/accounting/drc-vat-export')) as string;
    const history = await getDRCHistory(S.A);
    await pool.query('UPDATE suppliers SET company_name = name WHERE id = $1', [S.SUPP_A]);
    await pool.query('UPDATE supplier_invoices SET is_drc = false WHERE company_id = $1', [S.A]);
    expect(csv).not.toContain(S.LEAK_SUPPLIER);
    expect(csv).not.toMatch(/\bnull\b/i);
    const rows = csv.split('\n').slice(1).map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '')));
    expect(rows.map((r) => r[0]).sort()).toEqual(history.map((h) => h.invoiceNumber).sort());
    expect(rows.map((r) => [r[0], r[1]]).sort()).toEqual([
      [`${S.TAG}-AP-OK`, OK_SUPPLIER],
      [`${S.TAG}-AP-POISONED`, UNKNOWN_SUPPLIER],
    ].sort());
  });

  it('customer-payments-export: all and by status', async () => {
    const url = '/api/accounting/customer-payments-export';
    cleared(await get(customerPaymentsExport, url), docNo(S, 'CP', 'POISONED'), OK_CUSTOMER);
    cleared(await get(customerPaymentsExport, url, { status: 'confirmed' }), docNo(S, 'CP', 'POISONED'), OK_CUSTOMER);
  });

  it('dashboard-todos keeps the overdue bill', async () => {
    cleared(await get(dashboardTodos, '/api/accounting/dashboard-todos'), `${S.TAG}-AP-POISONED`, OK_SUPPLIER);
  });

  it('projects: all and by status', async () => {
    const url = '/api/accounting/projects';
    cleared(await get(projects, url), docNo(S, 'PRJ', 'POISONED'), OK_CUSTOMER);
    cleared(await get(projects, url, { status: 'active' }), docNo(S, 'PRJ', 'POISONED'), OK_CUSTOMER);
  });

  it('purchase-orders: all, by status, by supplier, and one order', async () => {
    const url = '/api/accounting/purchase-orders';
    const marker = docNo(S, 'PO', 'POISONED');
    cleared(await get(purchaseOrders, url), marker, OK_SUPPLIER);
    cleared(await get(purchaseOrders, url, { status: 'approved' }), marker, OK_SUPPLIER);
    cleared(await get(purchaseOrders, url, { supplierId: S.SUPP_B }), marker);
    cleared(await get(purchaseOrder, `${url}/${docs.POISONED.poolPo}`, { id: docs.POISONED.poolPo }), marker);
  });

  it('supplier-returns keeps the return', async () => {
    cleared(await get(supplierReturns, '/api/accounting/supplier-returns'), docNo(S, 'SCN', 'POISONED'), OK_SUPPLIER);
  });

  it('purchases-by-supplier keeps the bill\'s amount on its own row under UNKNOWN_SUPPLIER', async () => {
    const res = await callRoute(purchasesBySupplier as Route, tokens[user]!, S.A, 'GET', undefined,
      '/api/accounting/reports/purchases-by-supplier', { from: '2026-05-01', to: '2026-05-31' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const rows = (res.state.body as { data: { supplierId: string; supplierName: string; totalPurchases: number }[] }).data;
    expect(rows.find((r) => r.supplierId === S.SUPP_B)).toMatchObject({ supplierName: UNKNOWN_SUPPLIER, totalPurchases: AMOUNTS.apPoisoned });
    expect(rows.find((r) => r.supplierId === S.SUPP_A)).toMatchObject({ supplierName: OK_SUPPLIER, totalPurchases: AMOUNTS.apOk });
  });

  it('portal/invoice: a token holder is not shown B\'s customer', async () => {
    const token = randomBytes(32).toString('hex');
    await pool.query('UPDATE customer_invoices SET portal_token = $2 WHERE id = $1', [docs.POISONED.arInvoice, token]);
    const req = request({}, 'GET');
    (req as unknown as { query: unknown }).query = { token };
    const result = response();
    await (portalInvoice as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(200);
    expect(JSON.stringify(result.state.body)).not.toContain(S.LEAK_CUSTOMER);
    expect((result.state.body as { data: { customer_name: string } }).data.customer_name).toBe('Customer');
  });
});
