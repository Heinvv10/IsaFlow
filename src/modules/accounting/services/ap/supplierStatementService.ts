/**
 * The supplier side of a statement of account: what we owe one supplier, and
 * the documents that got us there.
 *
 * BUILD, not a wrap — there was no supplier statement anywhere. It is the
 * deliberate mirror of `ar/statementEmailService#fetchStatementData`, including
 * its two hard-won rules, because a supplier statement that disagreed with the
 * customer one about what counts would be worse than none:
 *
 *   - a credit note counts whether it is `approved` or `applied`. Filtering to
 *     `approved` alone is what hid every applied customer credit note from
 *     every statement ever sent.
 *   - a payment settles nothing until it is processed. A draft one does NOT
 *     reduce the balance, but it is named in `excluded` with its amount rather
 *     than dropped in silence — 56 draft supplier payments sit on these books.
 *
 * SIGN CONVENTION. This is a payable, so it runs the other way to the customer
 * statement: an invoice CREDITS the balance (we owe more), a payment DEBITS it
 * (we owe less), and a positive closing balance means we owe the supplier.
 *
 * Do not confuse this with `supplier_statement_reconciliations`, which compares
 * a statement the SUPPLIER sent us against our own ledger. This builds ours.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

type Row = DbRow;

export interface SupplierStatementTransaction {
  date: string;
  type: 'invoice' | 'payment' | 'credit_note';
  reference: string;
  /** Reduces what we owe. */
  debit: number;
  /** Increases what we owe. */
  credit: number;
  /** What we owe after this line. */
  balance: number;
}

export interface SupplierStatementExclusion {
  id: string;
  reason: string;
  detail?: string;
  amount?: number;
  documentNumber?: string;
}

export interface SupplierStatementPayload {
  supplier: { id: string; name: string; email: string | null };
  /** Date of the EARLIEST transaction found, not a rolling window. */
  fromDate: string;
  toDate: string;
  transactions: SupplierStatementTransaction[];
  excluded: SupplierStatementExclusion[];
  universeTotal: number;
  summary: {
    totalInvoiced: number;
    totalPaid: number;
    totalCredits: number;
    /** Positive means we owe the supplier. */
    balance: number;
  };
  /** MAX(created_at) across the documents consumed, ISO-8601, or null. */
  postedThrough: string | null;
}

/** A supplier payment settles nothing until it has been processed. */
const SETTLING_PAYMENT_STATUSES = new Set(['processed', 'reconciled', 'paid']);
/** A credit note is 'approved' standing alone and 'applied' once set against a bill. */
const LIVE_CREDIT_NOTE_STATUSES = new Set(['approved', 'applied']);

function maxIso(values: Array<unknown>): string | null {
  const iso = values
    .filter((v) => v != null)
    .map((v) => new Date(String(v)).toISOString())
    .sort();
  return iso.length > 0 ? iso[iso.length - 1]! : null;
}

/** Returns null when the supplier is not in this company — never a distinct reply. */
export async function fetchSupplierStatementData(
  companyId: string,
  supplierId: string,
  asAtDate: string,
): Promise<SupplierStatementPayload | null> {
  const supplierRows = (await sql`
    SELECT id, name, email
    FROM suppliers
    WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (supplierRows.length === 0) return null;
  const supplier = supplierRows[0]!;

  const [invoices, payments, creditNotes] = await Promise.all([
    sql`
      SELECT id, invoice_number, invoice_date, total_amount, status, created_at
      FROM supplier_invoices
      WHERE supplier_id = ${supplierId}::UUID
        AND company_id = ${companyId}::UUID
        AND status != 'cancelled'
        AND invoice_date <= ${asAtDate}::DATE
      ORDER BY invoice_date
    ` as Promise<Row[]>,

    sql`
      SELECT sp.id, sp.payment_number, sp.payment_date, sp.status, sp.created_at,
        COALESCE(SUM(spa.amount_allocated), sp.total_amount) AS amount_allocated
      FROM supplier_payments sp
      LEFT JOIN supplier_payment_allocations spa ON spa.payment_id = sp.id
      WHERE sp.supplier_id = ${supplierId}::UUID
        AND sp.company_id = ${companyId}::UUID
        AND sp.payment_date <= ${asAtDate}::DATE
      GROUP BY sp.id, sp.payment_number, sp.payment_date, sp.total_amount, sp.status, sp.created_at
    ` as Promise<Row[]>,

    sql`
      SELECT id, credit_note_number, credit_date, total_amount, status, created_at
      FROM credit_notes
      WHERE supplier_id = ${supplierId}::UUID
        AND company_id = ${companyId}::UUID
        AND type = 'supplier'
        AND credit_date <= ${asAtDate}::DATE
    ` as Promise<Row[]>,
  ]);

  const transactions: SupplierStatementTransaction[] = [];
  const excluded: SupplierStatementExclusion[] = [];

  for (const inv of invoices) {
    transactions.push({
      date: fmtDate(inv.invoice_date),
      type: 'invoice',
      reference: String(inv.invoice_number ?? ''),
      debit: 0,
      credit: Number(inv.total_amount),
      balance: 0,
    });
  }
  for (const pmt of payments) {
    const status = String(pmt.status ?? '');
    if (!SETTLING_PAYMENT_STATUSES.has(status)) {
      excluded.push({
        id: String(pmt.id),
        reason: 'payment_not_processed',
        detail: `Payment is '${status}'; it settles nothing until it is processed.`,
        amount: Number(pmt.amount_allocated),
        documentNumber: String(pmt.payment_number ?? ''),
      });
      continue;
    }
    transactions.push({
      date: fmtDate(pmt.payment_date),
      type: 'payment',
      reference: String(pmt.payment_number ?? ''),
      debit: Number(pmt.amount_allocated),
      credit: 0,
      balance: 0,
    });
  }
  for (const cn of creditNotes) {
    const status = String(cn.status ?? '');
    if (!LIVE_CREDIT_NOTE_STATUSES.has(status)) {
      excluded.push({
        id: String(cn.id),
        reason: 'credit_note_not_live',
        detail: `Credit note is '${status}'; only approved and applied notes reduce what we owe.`,
        amount: Number(cn.total_amount),
        documentNumber: String(cn.credit_note_number ?? ''),
      });
      continue;
    }
    transactions.push({
      date: fmtDate(cn.credit_date),
      type: 'credit_note',
      reference: String(cn.credit_note_number ?? ''),
      debit: Number(cn.total_amount),
      credit: 0,
      balance: 0,
    });
  }

  // Same ordering rule as the customer statement: by date, then invoice before
  // the credits and payments that settle it, so the running balance reads the
  // way a human would write it out.
  const typeOrder: Record<string, number> = { invoice: 0, credit_note: 1, payment: 2 };
  transactions.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
  });

  let running = 0;
  let totalInvoiced = 0;
  let totalPaid = 0;
  let totalCredits = 0;
  for (const txn of transactions) {
    running += txn.credit - txn.debit;
    txn.balance = running;
    totalInvoiced += txn.credit;
    if (txn.type === 'payment') totalPaid += txn.debit;
    if (txn.type === 'credit_note') totalCredits += txn.debit;
  }

  return {
    supplier: {
      id: String(supplier.id),
      name: String(supplier.name),
      email: supplier.email ? String(supplier.email) : null,
    },
    fromDate: transactions[0]?.date ?? asAtDate,
    toDate: asAtDate,
    transactions,
    excluded,
    universeTotal: transactions.length + excluded.length,
    summary: { totalInvoiced, totalPaid, totalCredits, balance: running },
    postedThrough: maxIso([
      ...invoices.map((r) => r.created_at),
      ...payments.map((r) => r.created_at),
      ...creditNotes.map((r) => r.created_at),
    ]),
  };
}
