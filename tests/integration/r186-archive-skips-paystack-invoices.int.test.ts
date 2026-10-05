/**
 * R-186: the archive skips customer invoices a Paystack or Stitch payment request references.
 *
 * Both requests' `customer_invoice_id` is ON DELETE SET NULL, and
 * `paystack_pr_invoice_has_invoice` / `stitch_pr_invoice_has_invoice` require it for purpose
 * 'customer_invoice', so deleting such an invoice raised 23514 and rolled the whole run back.
 * The r183-r187 goal file's default (2026-10-03, not put to Hein): skip those invoices (same
 * company), report how many, leave the requests alone. The preview predicts the same skip.
 *
 * Invoices are paid or cancelled with no allocation row, so R-053 (a paid invoice's allocation
 * blocks the delete on 23503) stays out of reach. Company A runs as app_user with the withAuth
 * GUCs, so the skip is proven under RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { executeArchive } from '@/modules/accounting/services/core/archiveExecutionService';
import { previewArchive } from '@/modules/accounting/services/core/archiveQueryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  CUTOFF, addCompany, addInvoice, addPaystackRequest, addStitchRequest, addUser, cleanup, drive, ids, pool, user,
} from './r186-archive.helpers';

assertDisposable();

/** A: one Paystack-referenced, one Stitch-referenced, one free invoice. The user belongs to every company. */
const coA = randomUUID();
/** B: its own referenced invoice; its requests naming C's and D's invoices are refused (R-195). */
const coB = randomUUID();
/** C: one invoice, which B's Paystack request may not name. */
const coC = randomUUID();
/** D: one invoice, which B's Stitch request may not name. */
const coD = randomUUID();
/** E: one archivable invoice beside three the archive must not count: approved, paid after the cutoff, approved and referenced. */
const coE = randomUUID();
const companies = [coA, coB, coC, coD, coE];
const inv = { aPaystack: '', aStitch: '', aFree: '', bRef: '', c: '', d: '' };
const req = { aPaystack: '', aStitch: '' };

beforeAll(async () => {
  await addUser();
  for (const id of companies) await addCompany(id, true);
  inv.aPaystack = await addInvoice(coA, 'cancelled');
  inv.aStitch = await addInvoice(coA, 'paid');
  inv.aFree = await addInvoice(coA, 'paid');
  inv.bRef = await addInvoice(coB, 'paid');
  inv.c = await addInvoice(coC, 'cancelled');
  inv.d = await addInvoice(coD, 'paid');
  req.aPaystack = await addPaystackRequest(coA, inv.aPaystack);
  req.aStitch = await addStitchRequest(coA, inv.aStitch);
  await addPaystackRequest(coB, inv.bRef);
  await addInvoice(coE, 'paid');
  await addInvoice(coE, 'approved');
  await addInvoice(coE, 'paid', '2010-01-01');
  await addPaystackRequest(coE, await addInvoice(coE, 'approved'));
});

afterAll(async () => { await cleanup(companies); });

describe('R-186: archive skips gateway-referenced customer invoices', () => {
  it('the preview predicts the skip, counting only this company\'s requests', async () => {
    const preview = await drive(coA, () => previewArchive(coA, CUTOFF), { appUser: true });
    expect(preview.customerInvoices).toBe(1);
    expect(preview.customerInvoicesSkipped).toBe(2);
    expect(preview.totalRecords).toBe(1);

    for (const co of [coC, coD, coE]) {
      const other = await drive(co, () => previewArchive(co, CUTOFF), { appUser: true });
      expect(other.customerInvoices).toBe(1);
      expect(other.customerInvoicesSkipped).toBe(0);
    }
  }, 40000);

  // Since R-195 the composite FK refuses a cross-company request, so the company_id predicate in
  // gatewayReferenced is only reachable with the FK gone: drop it in a rolled-back transaction and
  // forge B's requests on C's invoice. RLS shows them (the user belongs to B); the predicate must not.
  it('a forged request of another company (composite FK dropped, rolled back) does not make the preview skip', async () => {
    const preview = await drive(coC, () => previewArchive(coC, CUTOFF), { appUser: true, setup: async (client) => {
      await client.query('ALTER TABLE paystack_payment_requests DROP CONSTRAINT paystack_payment_requests_invoice_company_fkey');
      await client.query('ALTER TABLE stitch_payment_requests DROP CONSTRAINT stitch_payment_requests_invoice_company_fkey');
      await client.query(
        `INSERT INTO paystack_payment_requests(company_id,purpose,customer_invoice_id,paystack_reference,amount_cents,status)
         VALUES($1,'customer_invoice',$2,$3,10000,'completed')`, [coB, inv.c, `r186-${randomUUID()}`]);
      await client.query(
        `INSERT INTO stitch_payment_requests(company_id,purpose,customer_invoice_id,external_reference,amount_cents)
         VALUES($1,'customer_invoice',$2,$3,10000)`, [coB, inv.c, `r186-${randomUUID()}`]);
    } });
    expect(preview.customerInvoices).toBe(1);
    expect(preview.customerInvoicesSkipped, 'company B\'s forged request counted in C\'s preview').toBe(0);
  }, 40000);

  it('as app_user: archives the free invoice, skips both referenced ones, leaves them and their requests intact', async () => {
    let result: Awaited<ReturnType<typeof executeArchive>>;
    try {
      result = await drive(coA, () => executeArchive(coA, CUTOFF, user), { commit: true, appUser: true });
    } catch (err) {
      throw new Error(`executeArchive threw ${(err as { code?: string }).code ?? ''} ${(err as Error).message}`);
    }
    expect(result.invoicesArchived).toBe(1);
    expect(result.invoicesSkipped).toBe(2);

    expect(await ids('SELECT id FROM customer_invoices WHERE company_id=$1', [coA]))
      .toEqual([inv.aPaystack, inv.aStitch].sort());
    expect(await ids('SELECT id FROM archive_customer_invoices WHERE company_id=$1', [coA])).toEqual([inv.aFree]);
    const paystack = (await pool.query(
      'SELECT customer_invoice_id, status FROM paystack_payment_requests WHERE id=$1', [req.aPaystack])).rows[0];
    expect(paystack).toEqual({ customer_invoice_id: inv.aPaystack, status: 'completed' });
    const stitch = (await pool.query(
      'SELECT customer_invoice_id FROM stitch_payment_requests WHERE id=$1', [req.aStitch])).rows[0];
    expect(stitch).toEqual({ customer_invoice_id: inv.aStitch });
    const run = (await pool.query('SELECT status, invoices_archived FROM archive_runs WHERE company_id=$1', [coA])).rows;
    expect(run).toEqual([{ status: 'completed', invoices_archived: 1 }]);
    const audit = (await pool.query(
      "SELECT changes->'metadata'->>'invoicesSkipped' AS skipped FROM audit_log WHERE company_id=$1 AND entity_type='archive_run'",
      [coA])).rows;
    expect(audit).toEqual([{ skipped: '2' }]);

    expect(await ids('SELECT id FROM customer_invoices WHERE company_id=$1', [coB])).toEqual([inv.bRef]);
  }, 40000);

  // Cross-tenant: RLS shows C's invoice to a user who belongs to both B and C. Before R-195 the
  // FK was single-column, B's request was stored, and C's run then failed whole on 23514. The
  // composite FK (migration 854) refuses the request itself, so C's archive is C's to decide.
  it.each([
    ['Paystack', addPaystackRequest, () => coC, () => inv.c, 'paystack_payment_requests_invoice_company_fkey'],
    ['Stitch', addStitchRequest, () => coD, () => inv.d, 'stitch_payment_requests_invoice_company_fkey'],
  ])('a %s request in another company naming the invoice is refused at insert (23503), so the run archives it',
    async (_gateway, addRequest, co, invoice, constraint) => {
      const refused = await addRequest(coB, invoice()).then(() => ({}),
        (err: { code?: string; constraint?: string }) => ({ code: err.code, constraint: err.constraint }));
      expect(refused, 'company B\'s request was stored against another company\'s invoice').toEqual({ code: '23503', constraint });
      const result = await drive(co(), () => executeArchive(co(), CUTOFF, user), { commit: true, appUser: true });
      expect(result.invoicesArchived).toBe(1);
      expect(await ids('SELECT id FROM customer_invoices WHERE company_id=$1', [co()])).toEqual([]);
      expect(await ids('SELECT id FROM archive_customer_invoices WHERE company_id=$1', [co()])).toEqual([invoice()]);
    }, 40000);
});
