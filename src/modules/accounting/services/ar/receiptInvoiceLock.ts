/**
 * The invoices a customer receipt is about to claim, locked and read AS LOCKED.
 *
 * `createCustomerPayment` and `confirmCustomerPayment` both used to judge an allocation against an UNLOCKED read of
 * `customer_invoices` (AR audit 2026-10-18, B1/B2): two concurrent creates both passed the balance check, and a draft
 * receipt confirmed after the invoice was paid another way (bank-line match, apply an unapplied receipt, FIFO — none of
 * which look at drafts) added its full allocation on top. Both now take `FOR UPDATE` here, in ONE statement ordered by
 * id (a consistent order across every receipt, so two receipts sharing two invoices cannot deadlock), under the bounded
 * `withCustomerInvoiceLock` budget, and judge the allocation against what the lock returns.
 *
 * Lock order is the one `customerInvoiceLock.ts` documents: payment, then invoice.
 */
import { sql } from '@/lib/neon';
import { withCustomerInvoiceLock } from './customerInvoiceLock';
import { ReceiptRefusal } from './receiptRefusal';

export interface LockedReceiptInvoice {
  id: string;
  invoiceNumber: string;
  currencyCode: string | null;
  status: string;
  deleted: boolean;
  /** In whole cents, so no float rand difference can misjudge a cent. */
  totalCents: number;
  paidCents: number;
}

export const cents = (rand: string | number | null): number => Math.round(Number(rand ?? 0) * 100);

const rand = (c: number): string => (c / 100).toFixed(2);

/** Lock the named invoices of `companyId` (ascending id) and return them as locked. An absent id does not exist here. */
export async function lockReceiptInvoices(
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, LockedReceiptInvoice>> {
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) return new Map();
  const rows = await withCustomerInvoiceLock('lockReceiptInvoices', `${ids.length} invoice(s)`, () => sql<{
    id: string; invoice_number: string; currency_code: string | null; status: string;
    deleted_at: string | null; total_amount: string; amount_paid: string | null;
  }>`
    SELECT ci.id::text AS id, ci.invoice_number, ci.currency_code, ci.status, ci.deleted_at::text AS deleted_at,
           ci.total_amount::text AS total_amount, ci.amount_paid::text AS amount_paid
    FROM customer_invoices ci
    WHERE ci.id = ANY(${ids}::UUID[]) AND ci.company_id = ${companyId}::UUID
    ORDER BY ci.id
    FOR UPDATE OF ci
  `);
  return new Map(rows.map((r) => [r.id, {
    id: r.id,
    invoiceNumber: String(r.invoice_number),
    currencyCode: r.currency_code,
    status: String(r.status),
    deleted: r.deleted_at !== null,
    totalCents: cents(r.total_amount),
    paidCents: cents(r.amount_paid),
  }]));
}

/**
 * Refuse (ReceiptRefusal, before any write) a claim above what the LOCKED invoice still takes.
 * `pendingCents` is what OTHER draft receipts already claim (create counts them; confirm does not — a draft's own
 * allocation is what confirm is applying, and other drafts are not money received).
 */
export function assertWithinOutstanding(
  invoice: LockedReceiptInvoice, claimCents: number, pendingCents = 0, hint = '',
): void {
  const outstanding = invoice.totalCents - invoice.paidCents - pendingCents;
  if (claimCents <= outstanding) return;
  throw new ReceiptRefusal(
    `Allocation R${rand(claimCents)} exceeds invoice balance R${rand(Math.max(0, outstanding))} (${invoice.invoiceNumber})`
    + (pendingCents > 0 ? ` (R${rand(pendingCents)} already pending on draft payments)` : '')
    + hint,
  );
}
