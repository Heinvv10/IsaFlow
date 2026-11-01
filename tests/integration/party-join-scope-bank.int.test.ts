// tests/integration/party-join-scope-bank.int.test.ts
//
// Bank matching, bank rules, the bank list and Top Customers on a document of
// company A naming company B's party. Scoring runs on the label, so a foreign
// name there would also steer a match. The candidate stays, under UNKNOWN_*.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { AMOUNTS, dropAgingScope, newAgingScope, seedAgingScope } from '../helpers/agingScopeFixture';
import { docNo, dropPartyDocs, seedPartyDocs } from '../helpers/partyJoinScopeFixture';
import { UNKNOWN_CUSTOMER } from '@/modules/accounting/services/ar/arAgingInvoices';
import { UNKNOWN_SUPPLIER } from '@/modules/accounting/services/ap/apAgingInvoices';
import {
  fetchCustomerInvoiceCandidates, fetchPurchaseOrderCandidates, fetchSupplierInvoiceCandidates,
} from '@/modules/accounting/services/bank/bankMatchDbQueries';
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';
import { getRules } from '@/modules/accounting/services/bank/bankRulesService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { getAllBankTransactionsForExport } from '@/modules/accounting/services/bank/bankTxExportAll';
import { getTopCustomers } from '@/modules/accounting/services/reports/kpiChartsService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const S = newAgingScope();
const OK_CUSTOMER = `Tenant A Customer ${S.TAG}`;
const OK_SUPPLIER = `Tenant A Supplier ${S.TAG}`;

describeIfDb('bank matching and Top Customers do not read another tenant\'s party', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, party and bank fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await seedAgingScope(admin, S);
    await seedPartyDocs(admin, S);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await dropPartyDocs(admin, S);
    await dropAgingScope(admin, S);
    await admin.end();
  }, 60000);

  const noLeak = (result: unknown) => {
    const json = JSON.stringify(result);
    expect(json).not.toContain(S.LEAK_CUSTOMER);
    expect(json).not.toContain(S.LEAK_SUPPLIER);
  };
  const args = [1000, 1000, '2026-05-04', 'scope', '', []] as const;

  it('fetchSupplierInvoiceCandidates keeps the bill under UNKNOWN_SUPPLIER', async () => {
    const c = await fetchSupplierInvoiceCandidates(S.A, ...args);
    noLeak(c);
    expect(c.map((x) => x.label)).toContain(`${UNKNOWN_SUPPLIER} — Inv ${S.TAG}-AP-POISONED`);
    expect(c.map((x) => x.label)).toContain(`${OK_SUPPLIER} — Inv ${S.TAG}-AP-OK`);
  });

  it('fetchCustomerInvoiceCandidates keeps the invoice under UNKNOWN_CUSTOMER', async () => {
    const c = await fetchCustomerInvoiceCandidates(S.A, ...args);
    noLeak(c);
    expect(c.map((x) => x.label)).toContain(`${UNKNOWN_CUSTOMER} — Inv ${S.TAG}-AR-POISONED`);
    expect(c.map((x) => x.label)).toContain(`${OK_CUSTOMER} — Inv ${S.TAG}-AR-OK`);
  });

  it('fetchPurchaseOrderCandidates keeps the order under UNKNOWN_SUPPLIER', async () => {
    const c = await fetchPurchaseOrderCandidates(S.A, ...args);
    noLeak(c);
    expect(c.map((x) => x.label)).toContain(`${UNKNOWN_SUPPLIER} — PO ${docNo(S, 'PO', 'POISONED')}`);
    expect(c.map((x) => x.label)).toContain(`${OK_SUPPLIER} — PO ${docNo(S, 'PO', 'OK')}`);
  });

  it.each([
    ['POISONED', 777, () => `${UNKNOWN_CUSTOMER} — Inv ${S.TAG}-AR-POISONED`],
    ['OK', 1000, () => `${OK_CUSTOMER} — Inv ${S.TAG}-AR-OK`],
  ] as const)('getReceiptMatchCandidates offers the %s invoice under its own label', async (variant, amount, label) => {
    const { rows: [tx] } = await admin.query('SELECT id FROM bank_transactions WHERE company_id = $1 AND bank_reference = $2',
      [S.A, docNo(S, 'BT', variant)]);
    // A neutral description: this one would narrow the pool to the name sharing its tag.
    await admin.query(`UPDATE bank_transactions SET amount = $2, description = 'RECEIPT' WHERE id = $1`, [tx.id, amount]);
    const { candidates } = await getReceiptMatchCandidates(tx.id, S.A);
    noLeak(candidates);
    expect(candidates.map((x) => x.label)).toContain(label());
  });

  it('getRules does not name B\'s customer on the rule', async () => {
    const rules = await getRules(S.A);
    noLeak(rules);
    expect(rules).toHaveLength(2);
    expect(JSON.stringify(rules)).toContain(OK_CUSTOMER);
  });

  it.each([
    ['getBankTransactions', async () => (await getBankTransactions(S.A)).transactions],
    ['getAllBankTransactionsForExport', () => getAllBankTransactionsForExport(S.A, '2026-05-01', '2026-05-31', 100)],
  ])('%s does not suggest B\'s supplier or customer', async (_l, call) => {
    const rows = await call();
    noLeak(rows);
    expect(rows).toHaveLength(2);
    const json = JSON.stringify(rows);
    expect(json).toContain(OK_CUSTOMER);
    expect(json).toContain(OK_SUPPLIER);
  });

  it('getTopCustomers keeps the revenue, under UNKNOWN_CUSTOMER and per id', async () => {
    const other = (await admin.query(`INSERT INTO customers (company_id, name) VALUES ($1,$2) RETURNING id`, [S.B, `${S.LEAK_CUSTOMER} 2`])).rows[0].id;
    await admin.query(`INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, status, total_amount, created_by)
      VALUES ($1,$2,$2,$3,'2026-05-01','approved',3,$4)`, [S.A, other, `${S.TAG}-AR-P2`, S.USER]);
    const top = await getTopCustomers(S.A, 10);
    noLeak(top);
    expect(top).toEqual(expect.arrayContaining([
      { name: OK_CUSTOMER, revenue: AMOUNTS.arOk, invoiceCount: 1 },
      { name: UNKNOWN_CUSTOMER, revenue: AMOUNTS.arPoisoned, invoiceCount: 1 },
      { name: UNKNOWN_CUSTOMER, revenue: 3, invoiceCount: 1 },
    ]));
    expect(top).toHaveLength(3);
  });
});
