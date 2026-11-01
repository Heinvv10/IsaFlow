// tests/integration/party-join-scope-vat.int.test.ts
//
// VAT readers on a document of company A naming company B's party. The name
// must go; the document and its VAT must not. An inner join on the tenant match
// would drop the row and change the return, so the figures are pinned exactly.
// The poisoned invoices carry the party in both customer_id and client_id: the
// queries read it through two joins (customers c, clients cl), and either one
// alone would lend B's name.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropAgingScope, newAgingScope, seedAgingScope } from '../helpers/agingScopeFixture';
import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { getDRCEligibleInvoices, getDRCHistory } from '@/modules/accounting/services/reports/drcVatService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { findCustomerTaxCodeIssues, findSupplierTaxCodeIssues } from '@/modules/accounting/services/reports/vatTaxCodeIssues';
import { findUnpostedInvoiceVat } from '@/modules/accounting/services/reports/vatUnpostedInvoices';
import { findVatDeclaredElsewhere } from '@/modules/accounting/services/reports/vatDeclaredElsewhereQuery';
import { runReport } from '@/modules/accounting/services/reports/customReportRunner';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const S = newAgingScope();
const OK_CUSTOMER = `Tenant A Customer ${S.TAG}`;
const OK_SUPPLIER = `Tenant A Supplier ${S.TAG}`;
const MAY = ['2026-05-01', '2026-05-31'] as const;
const APRIL = ['2026-04-01', '2026-04-30'] as const;
const MARCH = ['2026-03-01', '2026-03-31'] as const;

describeIfDb('VAT readers keep the row and its VAT, and lose the foreign name', () => {
  let admin: Pool;

  /** A's own invoice and bill and a poisoned pair, dated `date`, with extra columns set. */
  async function pair(tag: string, date: string, set: Record<string, unknown>): Promise<void> {
    for (const [v, cust, supp] of [['OK', S.CUST_A, S.SUPP_A], ['POISONED', S.CUST_B, S.SUPP_B]] as const) {
      const cols = Object.keys(set);
      const vals = Object.values(set);
      const ph = vals.map((_, i) => `$${i + 6}`).join(',');
      await admin.query(`INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, status, total_amount, created_by, ${cols.join(',')})
        VALUES ($1,$2,$2,$3,$4,'approved',100,$5,${ph})`, [S.A, cust, `${S.TAG}-${tag}-AR-${v}`, date, S.USER, ...vals]);
      await admin.query(`INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, status, total_amount, created_by, ${cols.join(',')})
        VALUES ($1,$2,$3,$4,'approved',100,$5,${ph})`, [S.A, supp, `${S.TAG}-${tag}-AP-${v}`, date, S.USER, ...vals]);
    }
  }

  /** The aged pair carries VAT and a draft journal, so it is also a mismatch and unposted. */
  async function setMay(table: string, tag: string, subtotal: number, vat: number): Promise<void> {
    const je = (await admin.query(`INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status)
      VALUES ($1,'2026-05-01',$2,'draft') RETURNING id`, [S.A, S.USER])).rows[0].id;
    await admin.query(`UPDATE ${table} SET subtotal = $3, tax_rate = 15, tax_amount = $4, gl_journal_entry_id = $5
      WHERE company_id = $1 AND invoice_number = $2`, [S.A, `${S.TAG}-${tag}`, subtotal, vat, je]);
  }

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, party and invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await seedAgingScope(admin, S);
    await admin.query('UPDATE suppliers SET company_name = name WHERE id = ANY($1)', [[S.SUPP_A, S.SUPP_B]]);
    await setMay('customer_invoices', 'AR-OK', 1000, 150);
    await setMay('customer_invoices', 'AR-POISONED', 400, 60);
    await setMay('supplier_invoices', 'AP-OK', 2000, 300);
    await setMay('supplier_invoices', 'AP-POISONED', 800, 120);
    await pair('TC', APRIL[0], { subtotal: 100 });
    await pair('DE', MARCH[0], { subtotal: 100, tax_rate: 15, tax_amount: 15,
      vat_declared_elsewhere_at: new Date(), vat_declared_elsewhere_by: S.USER, vat_declared_elsewhere_reason: 'scope' });
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', [S.A]);
    await admin.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', [S.A]);
    await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [S.A]);
    await dropAgingScope(admin, S);
    await admin.end();
  }, 60000);

  const noLeak = (result: unknown) => {
    const json = JSON.stringify(result);
    expect(json).not.toContain(S.LEAK_CUSTOMER);
    expect(json).not.toContain(S.LEAK_SUPPLIER);
  };

  it('generateVAT201: every field still counts the poisoned documents; only the name went', async () => {
    const v = await generateVAT201(S.A, ...MAY);
    noLeak(v);
    expect(v.degradedSources).toEqual([]);
    expect(v.field1_standardRatedSupplies).toBe(1400);
    expect(v.field5_outputVAT).toBe(210);
    expect(v.field7_otherGoods).toBe(420);
    expect(v.field10_totalInputVAT).toBe(420);
    expect(v.field11_vatPayableOrRefundable).toBe(-210);
    expect(v.outputInvoices.map((i) => i.counterpartyName).sort()).toEqual([OK_CUSTOMER, 'Unknown'].sort());
    expect(v.inputInvoices.map((i) => i.counterpartyName).sort()).toEqual([OK_SUPPLIER, 'Unknown'].sort());
  });

  it('getVatExceptions keeps both mismatches, the poisoned ones as Unknown', async () => {
    const e = await getVatExceptions(S.A, ...MAY);
    noLeak(e);
    expect(e.invoiceGlMismatchCount).toBe(4);
    expect(e.invoiceGlMismatches.map((m) => m.counterpartyName).sort())
      .toEqual([OK_CUSTOMER, OK_SUPPLIER, 'Unknown', 'Unknown'].sort());
  });

  it('the tax-code lists keep the document under Unknown', async () => {
    const customers = await findCustomerTaxCodeIssues(S.A, ...APRIL);
    noLeak(customers);
    expect(customers.map((r) => r.counterparty_name).sort()).toEqual([OK_CUSTOMER, 'Unknown'].sort());
    const suppliers = await findSupplierTaxCodeIssues(S.A, ...APRIL);
    noLeak(suppliers);
    expect(suppliers.map((r) => r.counterparty_name).sort()).toEqual([OK_SUPPLIER, 'Unknown'].sort());
  });

  it('findUnpostedInvoiceVat keeps the document and its VAT under Unknown', async () => {
    const rows = await findUnpostedInvoiceVat(S.A, ...MAY);
    noLeak(rows);
    const customers = rows.filter((r) => r.kind === 'customer');
    expect(customers.map((r) => r.counterparty_name).sort()).toEqual([OK_CUSTOMER, 'Unknown'].sort());
    expect(customers.reduce((sum, r) => sum + Number(r.unposted_vat), 0)).toBe(210);
  });

  it('findVatDeclaredElsewhere keeps the document under Unknown', async () => {
    const rows = await findVatDeclaredElsewhere(S.A, ...MARCH);
    noLeak(rows);
    const customers = rows.filter((r) => r.kind === 'customer');
    expect(customers.map((r) => r.counterparty_name).sort()).toEqual([OK_CUSTOMER, 'Unknown'].sort());
  });

  it('getDRCHistory keeps the processed bill and drops the foreign name', async () => {
    await admin.query('UPDATE supplier_invoices SET is_drc = true WHERE company_id = $1 AND invoice_number LIKE $2', [S.A, `${S.TAG}-TC-AP-%`]);
    const rows = await getDRCHistory(S.A);
    noLeak(rows);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.supplierName === 'Unknown')).toHaveLength(1);
  });

  it('getDRCEligibleInvoices never reads the subject-to-DRC flag off another tenant\'s supplier', async () => {
    await admin.query('UPDATE suppliers SET subject_to_drc_vat = true WHERE id = $1', [S.SUPP_B]);
    await admin.query('UPDATE supplier_invoices SET is_drc = false WHERE company_id = $1', [S.A]);
    const rows = await getDRCEligibleInvoices(S.A);
    noLeak(rows);
    expect(rows).toEqual([]);
  });

  it('runReport on customer_invoices and supplier_invoices leaves the name blank, the row and the total in', async () => {
    const customer = await runReport(S.A, { dataSource: 'customer_invoices', columns: [{ field: 'invoice_number' }, { field: 'customer_name' }] } as never);
    noLeak(customer);
    expect(customer.rows.length).toBeGreaterThanOrEqual(6);
    expect(customer.rows.filter((r) => r.customer_name === OK_CUSTOMER)).toHaveLength(3);
    const supplier = await runReport(S.A, { dataSource: 'supplier_invoices', columns: [{ field: 'invoice_number' }, { field: 'supplier_name' }] } as never);
    noLeak(supplier);
    expect(supplier.rows).toHaveLength(6);
    expect(supplier.rows.filter((r) => r.supplier_name === OK_SUPPLIER)).toHaveLength(3);
  });
});
