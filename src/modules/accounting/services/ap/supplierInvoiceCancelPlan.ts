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
import { isVatPeriodLocked } from '../reports/vatPeriodLockService';
import { FIFO_ELIGIBLE_STATUSES } from '../ar/invoiceStatusRecompute';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';

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

/**
 * The plan the LIVE cancel acts on: the bill's row lock first, then the plan.
 * Payment and credit paths lock the bill before moving amount_paid, so every
 * refusal below is decided on figures no concurrent write can move before the
 * cancel (which re-locks the same row, a no-op) runs. Without the lock, the
 * plan's extra refusals — amount_paid, planned payments — were checked once
 * and never again.
 */
export async function lockAndPlanSupplierInvoiceCancel(
  companyId: string,
  invoiceId: string,
): Promise<SupplierInvoiceCancelPlan> {
  await lockSupplierInvoiceForUpdate(companyId, invoiceId);
  return planSupplierInvoiceCancel(companyId, invoiceId);
}

export async function planSupplierInvoiceCancel(
  companyId: string,
  invoiceId: string,
): Promise<SupplierInvoiceCancelPlan> {
  // deleted_at IS NULL, as the cancel's own lock: a soft-deleted bill is not
  // cancellable (K-053). One reply for absent and foreign — no existence oracle.
  const rows = (await sql`
    SELECT invoice_number, status, total_amount, COALESCE(amount_paid, 0) AS amount_paid,
           gl_journal_entry_id, COALESCE(payment_matched, false) AS payment_matched
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
  // Bank-matched with nothing applied: the legacy allocation path posted DR AP
  // off the bank line and set only this flag. Cancelling leaves that cash as an
  // unexplained supplier debit with no live document behind it.
  if (bill.payment_matched === true) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} is matched to a bank payment. Reverse that allocation first `
      + '(reverse_bank_allocation), then cancel it.',
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

  // Any OTHER posted, unreversed journal sourced from this bill — the DRC VAT
  // self-assessment is one — would stand for a cancelled document. The cancel
  // reverses only the approval journal, so these are refused by name.
  const others = (await sql`
    SELECT entry_number FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID AND source_record_id = ${invoiceId}::UUID
      AND status = 'posted' AND reversed_at IS NULL
      AND id IS DISTINCT FROM ${bill.gl_journal_entry_id ?? null}::UUID
    ORDER BY entry_number`) as DbRow[];
  if (others.length > 0) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} has other posted journal(s) sourced from it that the cancel would `
      + `leave standing: ${others.map((r) => String(r.entry_number)).join(', ')}. Reverse them with `
      + 'reverse_journal_entry first.',
    );
  }

  const base = { invoiceId, invoiceNumber: number, status, totalAmount: Number(bill.total_amount) };
  const entry = bill.gl_journal_entry_id
    ? await getJournalEntryById(companyId, String(bill.gl_journal_entry_id))
    : null;
  if (entry && entry.status === 'draft') {
    // Nulling the link would orphan a draft that still credits AP when posted.
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} is linked to draft journal ${entry.entryNumber}. Delete or post `
      + 'that journal first, then cancel.',
    );
  }
  // An approved bill with NO journal behind it (a Sage import, a stranded
  // journal): cancelling drops it from the AP subledger while any control-account
  // credit carrying it stays in the GL. A journal already reversed is different —
  // the GL has already let go of it.
  if (!entry && FIFO_ELIGIBLE_STATUSES.includes(status)) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number} is ${status} but has no approval journal to reverse, so cancelling `
      + 'it would take it out of the AP subledger while the general ledger keeps whatever carried it. '
      + 'Reconcile it by hand.',
    );
  }
  // The cancel reverses only a posted, not-yet-reversed journal — the same test here.
  if (!entry || entry.status !== 'posted' || entry.reversedAt) return { ...base, journal: null };
  if (!entry.lines || entry.lines.length === 0) {
    throw new SupplierInvoiceCancelRefusal(
      `Supplier invoice ${number}'s journal ${entry.entryNumber} has no lines, so it cannot be reversed. `
      + 'Reconcile it by hand.',
    );
  }
  const reversalDate = await resolveReversalDate(companyId, fmtDate(entry.entryDate), undefined);
  // A contra inside a locked VAT period changes a return already filed.
  if (await isVatPeriodLocked(companyId, reversalDate)) {
    throw new SupplierInvoiceCancelRefusal(
      `Cancelling supplier invoice ${number} would post its reversal on ${reversalDate}, inside a `
      + 'locked VAT period — it would change a VAT201 already filed. Unlock the period, or reverse '
      + 'the journal with reverse_journal_entry on a date in an open VAT period, then cancel.',
    );
  }
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
