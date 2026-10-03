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
  CUTOFF, addCompany, addInvoice, addPaystackRequest, addStitchRequest, addUser, cleanup, drive, failureOf, ids, pool, user,
} from './r186-archive.helpers';

assertDisposable();

/** A: one Paystack-referenced, one Stitch-referenced, one free invoice. The user belongs to every company. */
const coA = randomUUID();
/** B: its own referenced invoice, and a request naming C's invoice. */
const coB = randomUUID();
/** C: one invoice, referenced only by B's Paystack request. */
const coC = randomUUID();
/** D: one invoice, referenced only by B's Stitch request. */
const coD = randomUUID();
const companies = [coA, coB, coC, coD];
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
  // Cross-tenant: the FK is single-column, so nothing stops a request in B naming C's
  // invoice, and RLS shows it to a user who belongs to both. It must not decide C's archive.
  await addPaystackRequest(coB, inv.c);
  await addStitchRequest(coB, inv.d);
});

afterAll(async () => { await cleanup(companies); });

describe('R-186: archive skips gateway-referenced customer invoices', () => {
  it('the preview predicts the skip, counting only this company\'s requests', async () => {
    const preview = await drive(coA, () => previewArchive(coA, CUTOFF), { appUser: true });
    expect(preview.customerInvoices).toBe(1);
    expect(preview.customerInvoicesSkipped).toBe(2);
    expect(preview.totalRecords).toBe(1);

    for (const co of [coC, coD]) {
      const other = await drive(co, () => previewArchive(co, CUTOFF), { appUser: true });
      expect(other.customerInvoices).toBe(1);
      expect(other.customerInvoicesSkipped).toBe(0);
    }
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

    expect(await ids('SELECT id FROM customer_invoices WHERE company_id=$1', [coB])).toEqual([inv.bRef]);
  }, 40000);

  it.each([
    ['Paystack', () => coC, () => inv.c, 'paystack_pr_invoice_has_invoice'],
    ['Stitch', () => coD, () => inv.d, 'stitch_pr_invoice_has_invoice'],
  ])('a %s request in another company does not shield the invoice, though RLS shows it: the run fails whole on 23514',
    async (_gateway, co, invoice, constraint) => {
      const failure = await failureOf(co(), () => executeArchive(co(), CUTOFF, user), true);
      expect(failure.code, 'company B\'s request shielded the invoice').toBe('23514');
      expect(failure.constraint).toBe(constraint);
      expect(await ids('SELECT id FROM customer_invoices WHERE company_id=$1', [co()])).toEqual([invoice()]);
      expect(await ids('SELECT id FROM archive_customer_invoices WHERE company_id=$1', [co()])).toEqual([]);
    }, 40000);
});
