/**
 * R-101 — document identity for the revived Sage customer-invoice importer:
 * a re-run after `resetMigration` must not book an invoice twice (the AR
 * twin of K-088), and a staged row never merges into a DIFFERENT invoice.
 *
 * Differences from the supplier side, all from the schema:
 *   - customer_invoices has no sage_invoice_id; the Sage id is stored as
 *     external_ref with external_system = 'sage' (migration 530).
 *   - the number is unique per COMPANY (uq_customer_invoices_company_number),
 *     not per counterparty, and the index includes soft-deleted and cancelled
 *     rows — a number held by any of those fails the row cleanly, not by 23505.
 *   - resetMigration('customer_invoices') itself died on 42703 until
 *     migration 694 gave the staging table gl_customer_invoice_id.
 *
 * Own company, so no other suite's pending rows join the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { importCustomerInvoices } from '@/modules/accounting/services/core/sageCustomerImportService';
import { resetMigration } from '@/modules/accounting/services/core/sageMigrationCompareService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageImportHarness } from './r021-sage-supplier-import.helpers';
import { sageCustomerStaging } from './r101-sage-customer-import.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyC = randomUUID();
const user = randomUUID();
const NAME = 'R101R Customer';
let customerId = '';

const { drive } = sageImportHarness(pool, user);
const { seedStaging, staged, addCustomer, addInvoice, setUp, tearDown, tag } = sageCustomerStaging(pool);
const run = () => drive(companyC, () => importCustomerInvoices(companyC, user));
const byNumber = async (number: string) => (await pool.query(
  'SELECT id, external_ref, external_system, external_document_number, customer_id FROM customer_invoices WHERE company_id=$1 AND invoice_number=$2',
  [companyC, number],
)).rows;

beforeAll(async () => {
  await setUp([[companyC, 'R101R company']], user);
  customerId = await addCustomer(companyC, NAME);
});

afterAll(() => tearDown([companyC], user));

describe('R-101: a re-run does not book the invoice twice', () => {
  it('links the staged row to the invoice already in AR after a reset, and counts it skipped', async () => {
    const t = tag('R101R');
    const stagingId = await seedStaging(companyC, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: NAME, total: 575 });
    expect((await run()).succeeded).toBe(1);
    await drive(companyC, () => resetMigration(companyC, 'customer_invoices'));
    expect((await staged(stagingId)).migration_status).toBe('pending');

    const second = await run();
    expect(second.succeeded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.failed).toBe(0);
    const invoices = await byNumber(`${t}-INV`);
    expect(invoices).toHaveLength(1);
    expect(await staged(stagingId)).toEqual({ migration_status: 'imported', gl_customer_invoice_id: invoices[0]!.id });
  });

  it('imports again once the earlier invoice is soft-deleted, under a number it does not hold', async () => {
    const t = tag('R101D');
    await addInvoice(companyC, customerId, user, { number: `${t}-OLD`, total: 640, externalRef: `${t}-SAGE`, deleted: true });
    const stagingId = await seedStaging(companyC, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-NEW`, customerName: NAME, total: 640 });
    expect((await run()).succeeded).toBe(1);
    expect((await staged(stagingId)).migration_status).toBe('imported');
    expect(await byNumber(`${t}-NEW`)).toHaveLength(1);
  });

  it('a staged row with no Sage id and no number imports under SAGE-<staging id>, and a re-run links it', async () => {
    const stagingId = await seedStaging(companyC, { sageId: null, invoiceNumber: null, customerName: NAME, total: 33 });
    expect((await run()).failed).toBe(0);
    const rows = await byNumber(`SAGE-${stagingId}`);
    expect(rows).toHaveLength(1);
    expect([rows[0]!.external_ref, rows[0]!.external_system, rows[0]!.external_document_number]).toEqual([null, null, null]);
    await drive(companyC, () => resetMigration(companyC, 'customer_invoices'));
    const again = await run();
    expect(again.failed).toBe(0);
    expect(await byNumber(`SAGE-${stagingId}`)).toHaveLength(1);
    expect(await staged(stagingId)).toEqual({ migration_status: 'imported', gl_customer_invoice_id: rows[0]!.id });
  });

  it('two concurrent runs book each pending row once and leave no row failed', async () => {
    const t = tag('R101C');
    const N = 25;
    for (let i = 0; i < N; i++) {
      await seedStaging(companyC, { sageId: `${t}-${i}`, invoiceNumber: `${t}-INV${i}`, customerName: NAME, total: 100 + i });
    }
    const runs = await Promise.all([run(), run(), run()]);
    expect(runs.map(r => r.failed)).toEqual([0, 0, 0]);
    expect(runs.reduce((n, r) => n + r.succeeded, 0)).toBe(N);
    const n = (await pool.query(
      `SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND external_ref LIKE $2`, [companyC, `${t}-%`],
    )).rows[0]!.n;
    expect(n).toBe(N);
  });
});

describe('R-101: a staged row never merges into a different invoice', () => {
  it('fails a distinct Sage invoice that reuses a number already booked', async () => {
    const t = tag('R101N');
    await seedStaging(companyC, { sageId: `${t}-S1`, invoiceNumber: `${t}-RENT`, customerName: NAME, total: 10000, invoiceDate: '2026-05-31' });
    const second = await seedStaging(companyC, { sageId: `${t}-S2`, invoiceNumber: `${t}-RENT`, customerName: NAME, total: 10000 });
    const result = await run();
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(await staged(second)).toEqual({ migration_status: 'failed', gl_customer_invoice_id: null });
    expect((await byNumber(`${t}-RENT`))[0]!.external_ref).toBe(`${t}-S1`);
  });

  it('fails a row whose number another customer’s invoice holds (the number is unique per company)', async () => {
    const t = tag('R101P');
    const other = await addCustomer(companyC, `${t} Other`);
    await addInvoice(companyC, other, user, { number: `${t}-SHARED`, total: 250 });
    const stagingId = await seedStaging(companyC, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-SHARED`, customerName: NAME, total: 250 });
    const result = await run();
    expect(result.failed).toBe(1);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    const rows = await byNumber(`${t}-SHARED`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customer_id).toBe(other);
    expect(rows[0]!.external_ref).toBeNull();
  });

  it.each([
    ['soft-deleted', { deleted: true }],
    ['cancelled', { status: 'cancelled' }],
    ['draft', { status: 'draft' }],
    ['pending-approval', { status: 'pending_approval' }],
  ])('fails, without aborting the run, a row whose number a %s invoice holds', async (_label, opts) => {
    const t = tag('R101H');
    await addInvoice(companyC, customerId, user, { number: `${t}-INV`, total: 640, externalRef: `${t}-SAGE`, ...opts });
    const blocked = await seedStaging(companyC, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: NAME, total: 640 });
    const fine = await seedStaging(companyC, { sageId: `${t}-OK`, invoiceNumber: `${t}-OK`, customerName: NAME, total: 10 });
    const result = await run();
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect((await staged(blocked)).migration_status).toBe('failed');
    expect((await staged(fine)).migration_status).toBe('imported');
    expect(await byNumber(`${t}-INV`)).toHaveLength(1);
  });

  it('does not let a hand-captured invoice of another total absorb Sage invoices under its number', async () => {
    const t = tag('R101M');
    await addInvoice(companyC, customerId, user, { number: `${t}-RENT`, total: 9000 });
    const m1 = await seedStaging(companyC, { sageId: `${t}-M1`, invoiceNumber: `${t}-RENT`, customerName: NAME, total: 10000 });
    const result = await run();
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect((await staged(m1)).migration_status).toBe('failed');
    expect((await byNumber(`${t}-RENT`))[0]!.external_ref).toBeNull();
  });

  it('does not adopt a hand-captured invoice of the same number, customer and total but another date', async () => {
    const t = tag('R101DT');
    const hand = await addInvoice(companyC, customerId, user, { number: `${t}-FEE`, total: 100 });
    const stagingId = await seedStaging(companyC, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-FEE`, customerName: NAME, total: 100, invoiceDate: '2026-06-30' });
    const result = await run();
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    expect((await pool.query('SELECT external_ref FROM customer_invoices WHERE id=$1', [hand])).rows[0]!.external_ref).toBeNull();
  });

  it('adopts a hand-captured invoice of the same number, customer, total and date once, then refuses the next', async () => {
    const t = tag('R101AD');
    const manual = await addInvoice(companyC, customerId, user, { number: `${t}-RENT`, total: 10000 });
    const a1 = await seedStaging(companyC, { sageId: `${t}-A1`, invoiceNumber: `${t}-RENT`, customerName: NAME, total: 10000, invoiceDate: '2026-05-01' });
    const a2 = await seedStaging(companyC, { sageId: `${t}-A2`, invoiceNumber: `${t}-RENT`, customerName: NAME, total: 10000, invoiceDate: '2026-07-31' });
    const result = await run();
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(await staged(a1)).toEqual({ migration_status: 'imported', gl_customer_invoice_id: manual });
    expect((await staged(a2)).migration_status).toBe('failed');
    const [inv] = await byNumber(`${t}-RENT`);
    expect([inv!.external_ref, inv!.external_system, inv!.external_document_number]).toEqual([`${t}-A1`, 'sage', `${t}-RENT`]);
  });

  it('fails a row whose number is held by an invoice another system references, even under the same ref string', async () => {
    const t = tag('R101XR');
    await addInvoice(companyC, customerId, user, { number: `${t}-INV`, total: 75, externalRef: `${t}-SAGE`, externalSystem: 'xero' });
    const stagingId = await seedStaging(companyC, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: NAME, total: 75 });
    expect((await run()).failed).toBe(1);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    expect((await byNumber(`${t}-INV`))[0]!.external_system).toBe('xero');
  });

  it('fails, not links, a re-pended row whose total no longer matches the invoice', async () => {
    const t = tag('R101T');
    const stagingId = await seedStaging(companyC, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-INV`, customerName: NAME, total: 100 });
    await run();
    await pool.query(
      "UPDATE sage_customer_invoices SET migration_status='pending', gl_customer_invoice_id=NULL, total_amount=5000 WHERE id=$1", [stagingId],
    );
    expect((await run()).failed).toBe(1);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    expect(await byNumber(`${t}-INV`)).toHaveLength(1);
  });

  it('fails a row whose Sage id is already booked on another customer, rather than booking the debt twice', async () => {
    const t = tag('R101X');
    const other = await addCustomer(companyC, `${t} Renamed`);
    await addInvoice(companyC, other, user, { number: `${t}-OLD`, total: 90, externalRef: `${t}-SAGE` });
    const stagingId = await seedStaging(companyC, { sageId: `${t}-SAGE`, invoiceNumber: `${t}-NEW`, customerName: NAME, total: 90 });
    const result = await run();
    expect(result.failed).toBe(1);
    expect((await staged(stagingId)).migration_status).toBe('failed');
    expect(await byNumber(`${t}-NEW`)).toHaveLength(0);
  });

  it('prefers the invoice that already carries the Sage id over an older one that only shares the number', async () => {
    const t = tag('R101O');
    const older = await addInvoice(companyC, customerId, user, { number: `${t}-N2`, total: 100, createdAgo: '1 day' });
    const bySage = await addInvoice(companyC, customerId, user, { number: `${t}-N1`, total: 100, externalRef: `${t}-S1` });
    const stagingId = await seedStaging(companyC, { sageId: `${t}-S1`, invoiceNumber: `${t}-N2`, customerName: NAME, total: 100 });
    await run();
    expect((await staged(stagingId)).gl_customer_invoice_id).toBe(bySage);
    expect((await pool.query('SELECT external_ref FROM customer_invoices WHERE id=$1', [older])).rows[0]!.external_ref).toBeNull();
  });
});
