/**
 * #1699 review: the custom report runner leaves soft-deleted rows out. A supplier merged away (deleted, with its
 * survivor) is not a second row of the Suppliers report and its balance is not in the total; the same holds for a deleted
 * customer is not a row of the Customers report (the same filter covers items and the invoice sources). Through the real runner on a throwaway cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReport } from '@/modules/accounting/services/reports/customReportRunner';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageMergedWorld } from './helpers/sageMergedSupplierWorld';

assertDisposable();
const w = sageMergedWorld('creport');
const { pool, companyId, inRequestTx, insPlain } = w;

beforeAll(() => w.seed(), 60000);
afterAll(async () => {
  await pool.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
  await w.drop();
}, 60000);

const run = (dataSource: string, field: string) =>
  inRequestTx(() => runReport(companyId, { dataSource, columns: [{ field }] } as never));

describe('custom report sources leave soft-deleted rows out', () => {
  it('Suppliers: a merged-away supplier is not a row', async () => {
    const survivor = await insPlain('Report Survivor');
    const gone = await insPlain('Report Gone');
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [gone, survivor]);
    const names = await run('suppliers', 'name');
    expect(names.rows.map((r) => r.name)).toEqual(['Report Survivor']);
    expect(names.rowCount).toBe(1);
  });

  it('Customers: a deleted customer is not a row', async () => {
    await pool.query("INSERT INTO customers (company_id, name) VALUES ($1, 'Report Cust Live'), ($1, 'Report Cust Gone')", [companyId]);
    await pool.query("UPDATE customers SET deleted_at = now() WHERE company_id = $1 AND name = 'Report Cust Gone'", [companyId]);
    expect((await run('customers', 'name')).rows.map((r) => r.name)).toEqual(['Report Cust Live']);
  });
});
