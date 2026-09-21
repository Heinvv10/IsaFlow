/**
 * Everything cancelling a supplier bill would refuse, answered from READS, and
 * the contra journal it would post.
 *
 * `cancelSupplierInvoice` raises its own refusals as plain Errors from inside
 * the write. A caller that turned those into a refusal could not tell one from
 * a failure after the contra posted, so the MCP tool asks this first and calls
 * the cancel with no catch. Every check here is one the cancel makes (or one
 * whose absence would leave a dangling record behind it), and the preview's
 * date comes from the same `resolveReversalDate` the reversal uses.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getJournalEntryById } from '../gl/journalEntryService';
import { resolveReversalDate } from '../gl/journalEntryReversalDate';

/** A refusal whose message is safe to show the caller. */
export class SupplierInvoiceCancelRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierInvoiceCancelRefusal';
  }
}

export interface CancelPreviewLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface SupplierInvoiceCancelPlan {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  totalAmount: number;
  /** The approval journal the cancel will reverse, or null when there is none to reverse. */
  journal: {
    id: string;
    entryNumber: string;
    reversalDate: string;
    /** The CONTRA's lines: the original's debits and credits swapped. */
    lines: CancelPreviewLine[];
  } | null;
}

const EPS = 0.005;

export async function planSupplierInvoiceCancel(
  companyId: string,
  invoiceId: string,
): Promise<SupplierInvoiceCancelPlan> {
  // deleted_at IS NULL, as the cancel's own lock: a soft-deleted bill is not
  // cancellable (K-053). One reply for absent and foreign — no existence oracle.
  const rows = (await sql`
    SELECT invoice_number, status, total_amount, COALESCE(amount_paid, 0) AS amount_paid,
           gl_journal_entry_id
    FROM supplier_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL`) as DbRow[];
  const bill = rows[0];
  if (!bill) throw new SupplierInvoiceCancelRefusal('Not found');
  const number = String(bill.invoice_number);
  const status = String(bill.status);
  const paid = Number(bill.amount_paid);

  if (status === 'cancelled') {
    throw new SupplierInvoiceCancelRefusal(`Supplier invoice ${number} is already cancelled.`);
  }
  // The cancel refuses paid/partially_paid by status; amount_paid is checked as
  // well, because credit applied to a bill whose status was not recomputed
  // would otherwise be orphaned on a cancelled document.
  if (status === 'paid' || status === 'partially_paid' || paid > EPS) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} has R${paid.toFixed(2)} applied to it by payments or credit notes. `
      + 'Undo those first (void_payment, cancel_credit_note), then cancel it.',
    );
  }
  // A draft or approved payment planning to pay this bill would be left
  // pointing at a cancelled document.
  const planned = (await sql`
    SELECT sp.payment_number, sp.status
    FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE pa.invoice_id = ${invoiceId}::UUID AND sp.company_id = ${companyId}::UUID
      AND sp.status IN ('draft', 'approved')
    ORDER BY sp.payment_number
    LIMIT 1`) as DbRow[];
  if (planned[0]) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} is allocated on ${String(planned[0].status)} payment `
      + `${String(planned[0].payment_number)}. Remove it from that payment (or cancel the payment) first.`,
    );
  }

  const base = { invoiceId, invoiceNumber: number, status, totalAmount: Number(bill.total_amount) };
  if (!bill.gl_journal_entry_id) return { ...base, journal: null };

  // The cancel reverses only a posted, not-yet-reversed journal — the same test here.
  const entry = await getJournalEntryById(companyId, String(bill.gl_journal_entry_id));
  if (!entry || entry.status !== 'posted' || entry.reversedAt) return { ...base, journal: null };
  if (!entry.lines || entry.lines.length === 0) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number}'s journal ${entry.entryNumber} has no lines, so it cannot be reversed. `
      + 'Reconcile it by hand.',
    );
  }
  const reversalDate = await resolveReversalDate(companyId, fmtDate(entry.entryDate), undefined);
  return {
    ...base,
    journal: {
      id: entry.id,
      entryNumber: entry.entryNumber,
      reversalDate,
      lines: entry.lines.map((l) => ({
        accountId: l.glAccountId,
        accountCode: l.accountCode ?? '',
        accountName: l.accountName ?? '',
        debit: l.credit,
        credit: l.debit,
      })),
    },
  };
}
