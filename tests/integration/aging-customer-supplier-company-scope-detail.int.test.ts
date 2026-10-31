// tests/integration/aging-customer-supplier-company-scope-detail.int.test.ts
//
// The per-customer / per-supplier drill-downs of the aging, on the same
// two-tenant fixture as aging-customer-supplier-company-scope.int.test.ts.
// Company A's document naming company B's party is A's own debt: the list ages
// it under UNKNOWN_*, so its drill-down must open on exactly that document,
// under that label, carrying nothing of B's. An id with neither a party of the
// caller's company nor an open document of it is not found.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { AMOUNTS, dropAgingScope, newAgingScope, seedAgingScope } from '../helpers/agingScopeFixture';
import { getARAgingDetail } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import { UNKNOWN_CUSTOMER } from '@/modules/accounting/services/ar/arAgingInvoices';
import { UNKNOWN_SUPPLIER } from '@/modules/accounting/services/ap/apAgingInvoices';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const S = newAgingScope();
const AS_AT = '2026-06-30';

describeIfDb('aging drill-downs are scoped to the caller company', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, customer, supplier and invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await seedAgingScope(admin, S);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await dropAgingScope(admin, S);
    await admin.end();
  }, 60000);

  it('getARAgingDetail(A, CUST_B) is exactly A\'s poisoned invoice under UNKNOWN_CUSTOMER, nothing of B\'s', async () => {
    const d = await getARAgingDetail(S.A, S.CUST_B, AS_AT);
    expect(d.client).toEqual({ id: S.CUST_B, name: UNKNOWN_CUSTOMER });
    expect(d.invoices).toHaveLength(1);
    expect(d.invoices[0]!.balance).toBe(AMOUNTS.arPoisoned);
    expect(d.invoices[0]!.entityId).toBe(S.CUST_B);
    expect(d.invoices[0]!.entityName).toBe(UNKNOWN_CUSTOMER);
    expect(d.buckets?.total).toBe(AMOUNTS.arPoisoned);
    const json = JSON.stringify(d);
    expect(json).not.toContain(S.LEAK_CUSTOMER);
    expect(json).not.toContain(`${S.TAG}-AR-B-OWN`);
  });

  it('getARAgingDetail(A, CUST_A) is A\'s legitimate invoice under A\'s customer name', async () => {
    const d = await getARAgingDetail(S.A, S.CUST_A, AS_AT);
    expect(d.client).toEqual({ id: S.CUST_A, name: `Tenant A Customer ${S.TAG}` });
    expect(d.invoices.map((i) => i.balance)).toEqual([AMOUNTS.arOk]);
  });

  it('getARAgingDetail(A, <unused uuid>) is not found', async () => {
    await expect(getARAgingDetail(S.A, randomUUID(), AS_AT)).rejects.toThrow(/not found/);
  });

  it('getAPAgingDetail(A, SUPP_B) is exactly A\'s foreign-supplier bill under UNKNOWN_SUPPLIER, nothing of B\'s', async () => {
    const d = await getAPAgingDetail(S.A, S.SUPP_B, AS_AT);
    expect(d.supplier).toEqual({ id: S.SUPP_B, name: UNKNOWN_SUPPLIER });
    expect(d.invoices).toHaveLength(1);
    expect(d.invoices[0]!.balance).toBe(AMOUNTS.apPoisoned);
    expect(d.invoices[0]!.entityId).toBe(S.SUPP_B);
    expect(d.invoices[0]!.entityName).toBe(UNKNOWN_SUPPLIER);
    expect(d.buckets?.total).toBe(AMOUNTS.apPoisoned);
    const json = JSON.stringify(d);
    expect(json).not.toContain(S.LEAK_SUPPLIER);
    expect(json).not.toContain(`${S.TAG}-AP-B-OWN`);
  });

  it('getAPAgingDetail(A, SUPP_A) is A\'s legitimate bill under A\'s supplier name', async () => {
    const d = await getAPAgingDetail(S.A, S.SUPP_A, AS_AT);
    expect(d.supplier).toEqual({ id: S.SUPP_A, name: `Tenant A Supplier ${S.TAG}` });
    expect(d.invoices.map((i) => i.balance)).toEqual([AMOUNTS.apOk]);
  });

  it('getAPAgingDetail(A, <unused uuid>) is not found', async () => {
    await expect(getAPAgingDetail(S.A, randomUUID(), AS_AT)).rejects.toThrow(/not found/);
  });
});
