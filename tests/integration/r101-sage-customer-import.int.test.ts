/**
 * R-101 — the Sage customer-invoice importer, on real PostgreSQL.
 *
 * `importCustomerInvoices` SELECTed columns `sage_customer_invoices` has never
 * had (`sage_invoice_id`, `client_id`, `subtotal`, `raw_data`, …), and wrote
 * back to a `gl_customer_invoice_id` it did not have either, so every run died
 * on 42703 before its loop — the customer twin of R-021. The staging table
 * holds (sage_id, invoice_number, customer_name, invoice_date, total_amount);
 * everything else is derived, as on the supplier side. A negative staged total
 * is a Sage credit note: it gets its own status, not 'failed' (R-119 note).
 *
 * Re-runs and document identity are in r101-sage-customer-import-rerun.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { importCustomerInvoices } from '@/modules/accounting/services/core/sageCustomerImportService';
import { getMigrationStatus } from '@/modules/accounting/services/core/sageMigrationService';
import { SAGE_VAT_NOT_STATED_NOTE } from '@/modules/accounting/services/shared/sageVatDerivation';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageImportHarness } from './r021-sage-supplier-import.helpers';
import { sageCustomerStaging } from './r101-sage-customer-import.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyA = randomUUID();
const companyB = randomUUID();
const user = randomUUID();
const CUSTOMER_NAME = 'R101 Customer';

const { drive, fmt } = sageImportHarness(pool, user);
const { seedStaging, staged, addCustomer, setUp, tearDown, tag } = sageCustomerStaging(pool);
const invoicesFor = async (companyId: string, sageId: string) => (await pool.query(
  `SELECT * FROM customer_invoices WHERE company_id=$1 AND external_system='sage' AND external_ref=$2`, [companyId, sageId],
)).rows;
const importA = () => drive(companyA, () => importCustomerInvoices(companyA, user));

beforeAll(async () => {
  await setUp([[companyA, 'R101 company A'], [companyB, 'R101 company B']], user);
  for (const id of [companyA, companyB]) await addCustomer(id, CUSTOMER_NAME, 30);
});

afterAll(() => tearDown([companyA, companyB], user));

describe('R-101: the importer reads the columns its source table actually has', () => {
  it('imports a staged invoice end to end and agrees with the staged total', async () => {
    const t = tag('R101');
    const stagingId = await seedStaging(companyA, {
      sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: CUSTOMER_NAME, total: 1150,
    });

    const result = await importA();
    expect(result.status).toBe('completed');
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.vatNotStated).toBe(1);

    const rows = await invoicesFor(companyA, `${t}-SAGE`);
    expect(rows).toHaveLength(1);
    const inv = rows[0]!;
    const customerId = (await pool.query(
      'SELECT id FROM customers WHERE company_id=$1 AND name=$2', [companyA, CUSTOMER_NAME],
    )).rows[0]!.id;
    expect(inv.customer_id).toBe(customerId);
    expect(inv.invoice_number).toBe(`${t}-INV`);
    expect(inv.external_document_number).toBe(`${t}-INV`);
    expect(Number(inv.total_amount)).toBe(1150);
    // R-089: staging states no VAT, so none is invented and the invoice is flagged.
    expect(Number(inv.subtotal)).toBe(1150);
    expect(Number(inv.tax_amount)).toBe(0);
    expect(Number(inv.tax_rate)).toBe(0);
    expect(inv.notes).toBe(SAGE_VAT_NOT_STATED_NOTE);
    // Unpaid: staging carries no payment state.
    expect(Number(inv.amount_paid)).toBe(0);
    expect(Number(inv.balance)).toBe(1150);
    expect(inv.status).toBe('approved');
    expect(fmt(inv.invoice_date)).toBe('2026-06-30');
    expect(fmt(inv.due_date)).toBe('2026-07-30');

    const s = await staged(stagingId);
    expect(s.migration_status).toBe('imported');
    expect(s.gl_customer_invoice_id).toBe(inv.id);
  });

  it('fails the row rather than inventing a customer when the name matches none', async () => {
    const t = tag('R101N');
    const stagingId = await seedStaging(companyA, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: 'Nobody At All', total: 500 });
    const result = await importA();
    expect(result.status).toBe('partial');
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    expect(await invoicesFor(companyA, `${t}-SAGE`)).toHaveLength(0);
  });

  it('fails the row when the name matches more than one live customer', async () => {
    const t = tag('R101A');
    const twin = `${t} Twin`;
    await addCustomer(companyA, twin);
    await addCustomer(companyA, twin.toUpperCase());
    const stagingId = await seedStaging(companyA, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: twin, total: 700 });
    const result = await importA();
    expect(result.failed).toBe(1);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    expect(await invoicesFor(companyA, `${t}-SAGE`)).toHaveLength(0);
  });

  it('ignores a soft-deleted customer of the same name, and matches one stored with padding', async () => {
    const t = tag('R101D');
    await pool.query('INSERT INTO customers(company_id,name,deleted_at) VALUES($1,$2,NOW())', [companyA, `${t} Reborn`]);
    const live = await addCustomer(companyA, `  ${t} Reborn  `);
    await seedStaging(companyA, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: `${t} Reborn`, total: 320 });
    expect((await importA()).succeeded).toBe(1);
    const rows = await invoicesFor(companyA, `${t}-SAGE`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customer_id).toBe(live);
  });

  it.each([[null, null], [45, '2026-08-14']])(
    'derives the due date from the customer’s own terms (%s days → %s)',
    async (terms, due) => {
      const t = tag('R101T');
      await addCustomer(companyA, `${t} Terms`, terms);
      await seedStaging(companyA, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: `${t} Terms`, total: 100 });
      expect((await importA()).succeeded).toBe(1);
      const inv = (await invoicesFor(companyA, `${t}-SAGE`))[0]!;
      expect(inv.due_date === null ? null : fmt(inv.due_date)).toBe(due);
    },
  );

  it('sets a negative staged total aside as a credit note — not failed, not booked', async () => {
    const t = tag('R101CN');
    const stagingId = await seedStaging(companyA, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-CN`, customerName: CUSTOMER_NAME, total: -115 });
    const result = await importA();
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.status).toBe('completed');
    expect((await staged(stagingId)).migration_status).toBe('credit_note');
    expect(await invoicesFor(companyA, `${t}-SAGE`)).toHaveLength(0);
    const status = await drive(companyA, () => getMigrationStatus(companyA));
    expect(status.customerInvoices.creditNotes).toBeGreaterThanOrEqual(1);
  });

  it('fails a row with no invoice date rather than booking an undated approved invoice', async () => {
    const t = tag('R101ND');
    const stagingId = (await pool.query<{ id: string }>(
      `INSERT INTO sage_customer_invoices (company_id, sage_id, invoice_number, customer_name, invoice_date, total_amount, migration_status)
       VALUES ($1,$2,$3,$4,NULL,250,'pending') RETURNING id`, [companyA, `${t}-SAGE`, `${t}-INV`, CUSTOMER_NAME],
    )).rows[0]!.id;
    expect((await importA()).failed).toBe(1);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    expect(await invoicesFor(companyA, `${t}-SAGE`)).toHaveLength(0);
  });

  it('fails a row whose total is zero', async () => {
    const t = tag('R101Z');
    const stagingId = await seedStaging(companyA, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: CUSTOMER_NAME, total: 0 });
    const result = await importA();
    expect(result.failed).toBe(1);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    expect(await invoicesFor(companyA, `${t}-SAGE`)).toHaveLength(0);
  });

  it('a row whose INSERT raises fails alone; the rest of the run still imports (per-row savepoint)', async () => {
    const t = tag('R101SP');
    // invoice_date + 2,147,000,000 days is past the date range: the INSERT raises 22008.
    await addCustomer(companyA, `${t} Forever`, 2_147_000_000);
    const bad = await seedStaging(companyA, { sageId: `${t}-BAD`, invoiceNumber: `${t}-BAD`, customerName: `${t} Forever`, total: 10, invoiceDate: '2026-01-01' });
    const good = await seedStaging(companyA, { sageId: `${t}-OK`, invoiceNumber: `${t}-OK`, customerName: CUSTOMER_NAME, total: 20, invoiceDate: '2026-12-31' });
    const result = await importA();
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect((await staged(bad)).migration_status).toBe('failed');
    expect((await staged(good)).migration_status).toBe('imported');
  });

  it('leaves another tenant’s pending rows alone and never books them into this company', async () => {
    const t = tag('R101X');
    const bStagingId = await seedStaging(companyB, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: CUSTOMER_NAME, total: 2300 });
    await importA();
    expect((await staged(bStagingId)).migration_status).toBe('pending');
    const leaked = (await pool.query(
      `SELECT company_id FROM customer_invoices WHERE external_system='sage' AND external_ref=$1`, [`${t}-SAGE`],
    )).rows;
    expect(leaked).toHaveLength(0);
  });
});
