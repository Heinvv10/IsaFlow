// tests/integration/party-join-scope-split-columns.int.test.ts
//
// customer_invoices names its party in two columns, and the party is
// COALESCE(client_id, customer_id). A join reading one column alone shows the
// wrong customer when they differ, and no customer on a row with client_id NULL.
// Every reader here must resolve the party the same way, and the tenant match
// must hold through either column.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import portalInvoice from '../../pages/api/portal/invoice/[token]';
import { UNKNOWN_CUSTOMER } from '@/modules/accounting/services/ar/arAgingInvoices';
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';
import { fetchCustomerInvoiceCandidates } from '@/modules/accounting/services/bank/bankMatchDbQueries';
import { getTopCustomers } from '@/modules/accounting/services/reports/kpiChartsService';
import { AMOUNTS, dropAgingScope, newAgingScope, seedAgingScope } from '../helpers/agingScopeFixture';
import { docNo, dropPartyDocs, seedPartyDocs, seedSplitColumnInvoices, SPLIT_AMOUNTS, SPLIT_ROWS, type SplitRow } from '../helpers/partyJoinScopeFixture';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const S = newAgingScope();
const OK_CUSTOMER = `Tenant A Customer ${S.TAG}`;
let split: Awaited<ReturnType<typeof seedSplitColumnInvoices>>;

beforeAll(async () => {
  await seedAgingScope(pool, S);
  await seedPartyDocs(pool, S);
  split = await seedSplitColumnInvoices(pool, S);
}, 60000);

afterAll(async () => {
  await dropPartyDocs(pool, S);
  await dropAgingScope(pool, S);
  await pool.end();
}, 60000);

const noForeign = (result: unknown) => {
  const json = JSON.stringify(result);
  expect(json).not.toContain(S.LEAK_CUSTOMER);
  expect(json).not.toContain(split.staleName);
};
const label = (row: SplitRow, name: string) => `${name} — Inv ${S.TAG}-${SPLIT_ROWS[row]}`;
/** Each row with the name it must carry on a list, the foreign ones under the unknown label. */
const ROWS = (): [SplitRow, string][] => [
  ['customerOnly', split.clientName], ['differ', split.clientName],
  ['foreignCustomerOnly', UNKNOWN_CUSTOMER], ['foreignClient', UNKNOWN_CUSTOMER],
];
const KEYS: SplitRow[] = ['customerOnly', 'differ', 'foreignCustomerOnly', 'foreignClient'];

describe('the party of an invoice is COALESCE(client_id, customer_id) on every reader', () => {
  it('getTopCustomers: one row per resolved party; a row whose columns agree moves nothing', async () => {
    const top = await getTopCustomers(S.A, 10);
    noForeign(top);
    expect(top).toEqual(expect.arrayContaining([
      { name: OK_CUSTOMER, revenue: AMOUNTS.arOk, invoiceCount: 1 },
      { name: split.clientName, revenue: SPLIT_AMOUNTS.customerOnly + SPLIT_AMOUNTS.differ, invoiceCount: 2 },
      { name: UNKNOWN_CUSTOMER, revenue: AMOUNTS.arPoisoned + SPLIT_AMOUNTS.foreignCustomerOnly + SPLIT_AMOUNTS.foreignClient, invoiceCount: 3 },
    ]));
    expect(top).toHaveLength(3);
  });

  it('fetchCustomerInvoiceCandidates labels each invoice with its resolved party', async () => {
    const c = await fetchCustomerInvoiceCandidates(S.A, 1000, 1000, '2026-05-04', 'scope', '', []);
    noForeign(c);
    expect(c.map((x) => x.label)).toEqual(expect.arrayContaining([
      ...ROWS().map(([row, name]) => label(row, name)),
      `${OK_CUSTOMER} — Inv ${S.TAG}-AR-OK`,
    ]));
  });

  it('getReceiptMatchCandidates labels each invoice with its resolved party', async () => {
    const { rows: [tx] } = await pool.query('SELECT id FROM bank_transactions WHERE company_id = $1 AND bank_reference = $2',
      [S.A, docNo(S, 'BT', 'OK')]);
    for (const [row, name] of ROWS()) {
      // A neutral description: this one would narrow the pool to the name sharing its tag.
      await pool.query(`UPDATE bank_transactions SET amount = $2, description = 'RECEIPT' WHERE id = $1`, [tx.id, SPLIT_AMOUNTS[row]]);
      const { candidates } = await getReceiptMatchCandidates(tx.id, S.A);
      noForeign(candidates);
      expect(candidates.map((x) => x.label)).toContain(label(row, name));
    }
  });

  it.each(KEYS)('portal/invoice names the resolved party, and no one else, on %s', async (row) => {
    const req = request({}, 'GET');
    (req as unknown as { query: unknown }).query = { token: split.tokens[row] };
    const result = response();
    await (portalInvoice as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(200);
    noForeign(result.state.body);
    const { customer_name: name } = (result.state.body as { data: { customer_name: string } }).data;
    expect(name).toBe(row === 'customerOnly' || row === 'differ' ? split.clientName : 'Customer');
  });
});
