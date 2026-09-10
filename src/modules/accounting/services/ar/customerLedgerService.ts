/**
 * Customer transaction ledger — the statement a customer is sent and asked to
 * pay. Every row on it is a claim about what they owe.
 *
 * Extracted from pages/api/accounting/reports-customer-ledger.ts, where it had
 * no tests because the arithmetic was inline in a route handler.
 *
 * Two defects it carried:
 *
 *   DRAFTS AND CANCELLED INVOICES WERE DEBITED. The invoice leg filtered only
 *   on deleted_at, with no status filter, so an invoice that had been issued to
 *   nobody appeared on the customer's statement as money owed. Production held
 *   130 drafts worth R5,555,315.66 and 58 cancelled worth R48,050.63.
 *
 *   CREDIT NOTES WERE ABSENT. Approving a credit note raises
 *   customer_invoices.amount_paid, but this ledger debits the GROSS
 *   total_amount and draws credits only from customer_payments — so a credit
 *   note reduced nothing here. 93 applied notes worth R372,634.32.
 *
 * Both overstate the balance, on a document that goes to the customer.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

/**
 * Invoice statuses that represent a real claim on the customer.
 *
 * Deliberately a positive list rather than `status NOT IN ('draft',
 * 'cancelled')`: a status added later defaults to being EXCLUDED from a
 * customer-facing statement, which is the safe direction to fail.
 */
const BILLABLE_INVOICE_STATUSES = [
  'approved',
  'sent',
  'partially_paid',
  'overdue',
  'paid',
] as const;

/** Credit note statuses that reduce what the customer owes. */
const EFFECTIVE_CREDIT_NOTE_STATUSES = ['approved', 'applied'] as const;

export type LedgerEntryType = 'invoice' | 'receipt' | 'credit_note';

export interface CustomerLedgerEntry {
  type: LedgerEntryType;
  transactionId: string;
  reference: string | null;
  transactionDate: string;
  debit: number;
  credit: number;
  status: string;
  /** Running balance after this entry. */
  balance: number;
}

export interface CustomerLedger {
  customerName: string;
  openingBalance: number;
  closingBalance: number;
  transactions: CustomerLedgerEntry[];
}

export interface CustomerLedgerOptions {
  dateFrom?: string | null;
  dateTo?: string | null;
}

interface Row {
  type: string;
  transaction_id: string;
  reference: string | null;
  transaction_date: Date | string;
  debit: string | number;
  credit: string | number;
  status: string;
}

/** pg returns DATE columns as Date; toISOString would roll back a day on UTC+2. */
function toDateStr(d: Date | string): string {
  return fmtDate(d) || String(d);
}

/**
 * Net of everything owing before `beforeDate` — the balance the statement
 * opens with.
 *
 * Uses the SAME three sources and the same status rules as the statement
 * itself, so the opening figure cannot disagree with the rows beneath it.
 *
 * Returning 0 here while `dateFrom` filtered the rows understated the debt: a
 * statement for March onward showed an opening balance of zero and asked the
 * customer only for March's invoices, silently dropping everything older. That
 * is the same defect as billing for a draft, in the opposite direction.
 *
 * `beforeDate` bounds WHICH documents are prior; `asAtStr` is the date the
 * soft-delete presence question is asked at — see getCustomerLedger for why
 * the two differ.
 */
async function fetchOpeningBalance(
  companyId: string,
  customerId: string,
  beforeDate: string,
  asAtStr: string,
): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS balance
    FROM (
      SELECT ci.total_amount AS amount
      FROM customer_invoices ci
      WHERE ci.company_id = ${companyId}
        AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}
        AND ci.status = ANY(${Array.from(BILLABLE_INVOICE_STATUSES)}::text[])
        AND ci.invoice_date < ${beforeDate}::date
        AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}

      UNION ALL

      SELECT -cp.total_amount
      FROM customer_payments cp
      WHERE cp.company_id = ${companyId}
        AND cp.client_id = ${customerId}
        AND cp.status != 'cancelled'
        AND cp.payment_date < ${beforeDate}::date

      UNION ALL

      SELECT -cn.total_amount
      FROM credit_notes cn
      WHERE cn.company_id = ${companyId}
        AND cn.client_id  = ${customerId}
        AND cn.type       = 'customer'
        AND cn.status = ANY(${Array.from(EFFECTIVE_CREDIT_NOTE_STATUSES)}::text[])
        AND cn.credit_date < ${beforeDate}::date
    ) prior
  `) as Array<{ balance: string | number }>;

  return Number(rows[0]?.balance ?? 0);
}

/** Null when the customer does not exist in this company. */
export async function getCustomerLedger(
  companyId: string,
  customerId: string,
  options: CustomerLedgerOptions = {},
): Promise<CustomerLedger | null> {
  const dateFrom = options.dateFrom ?? null;
  const dateTo = options.dateTo ?? null;
  /**
   * The as-at date the WHOLE document is drawn to, opening balance included.
   *
   * Soft-delete reverses the invoice's approval journal and dates the reversal
   * to the DELETE, so the AR control account keeps carrying the invoice right
   * up to that date. An undated `deleted_at IS NULL OR deleted_at > NOW()`
   * therefore drops from this statement an invoice the GL still shows at
   * `dateTo`, and the closing balance stops footing — the same clock mismatch
   * `reports-supplier-ledger` closed on the AP side.
   *
   * `dateTo` is optional and an absent one means up to now; the fallback is
   * today rather than NULL, which would make the fragment return NULL and drop
   * every soft-deleted invoice unconditionally.
   *
   * The OPENING balance is dated to `dateTo` too, not to `dateFrom`. This
   * statement lists documents, never the GL reversal the delete posts, so a
   * delete falling INSIDE the window produces no row: if the opening still
   * carried the invoice the closing would carry it as well, and disagree with
   * the control account at `dateTo`. Dating both legs to `dateTo` makes the
   * document one coherent snapshot whose closing figure ties to the GL.
   *
   * KNOWN COST of that choice: when the delete falls INSIDE the window, the row
   * printed as "Opening balance" for `dateFrom` reads what the customer owed
   * NET of that later deletion, not what the control account carried on
   * `dateFrom` itself. The closing figure and every printed row are right and
   * the arithmetic foots; only the opening label is dated differently from the
   * figure beside it. Fixing the label honestly means emitting a dated
   * "document removed" contra row so both legs can carry their own date, which
   * changes the statement's row contract and is not part of this item.
   */
  const asAtStr = dateTo ?? fmtDate(new Date());

  const customerRows = (await sql`
    SELECT name
    FROM customers
    WHERE id = ${customerId}
      AND company_id = ${companyId}
      AND deleted_at IS NULL
    LIMIT 1
  `) as { name: string }[];

  if (customerRows.length === 0 || customerRows[0] === undefined) return null;

  const openingBalance = dateFrom === null
    ? 0
    : await fetchOpeningBalance(companyId, customerId, dateFrom, asAtStr);

  const rows = (await sql`
    SELECT
      'invoice'                                   AS type,
      ci.id                                       AS transaction_id,
      ci.invoice_number                           AS reference,
      ci.invoice_date                             AS transaction_date,
      ci.total_amount                             AS debit,
      0                                           AS credit,
      ci.status
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}
      AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}
      AND ci.status = ANY(${Array.from(BILLABLE_INVOICE_STATUSES)}::text[])
      AND (${dateFrom}::date IS NULL OR ci.invoice_date >= ${dateFrom}::date)
      AND (${dateTo}::date IS NULL OR ci.invoice_date <= ${dateTo}::date)
      AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}

    UNION ALL

    SELECT
      'receipt'                                   AS type,
      cp.id                                       AS transaction_id,
      COALESCE(cp.bank_reference, cp.payment_number) AS reference,
      cp.payment_date                             AS transaction_date,
      0                                           AS debit,
      cp.total_amount                             AS credit,
      'paid'                                      AS status
    FROM customer_payments cp
    WHERE cp.company_id = ${companyId}
      AND cp.client_id = ${customerId}
      AND cp.status != 'cancelled'
      AND (${dateFrom}::date IS NULL OR cp.payment_date >= ${dateFrom}::date)
      AND (${dateTo}::date IS NULL OR cp.payment_date <= ${dateTo}::date)

    UNION ALL

    SELECT
      'credit_note'                               AS type,
      cn.id                                       AS transaction_id,
      cn.credit_note_number                       AS reference,
      cn.credit_date                              AS transaction_date,
      0                                           AS debit,
      cn.total_amount                             AS credit,
      cn.status
    FROM credit_notes cn
    WHERE cn.company_id = ${companyId}
      AND cn.client_id  = ${customerId}
      AND cn.type       = 'customer'
      AND cn.status = ANY(${Array.from(EFFECTIVE_CREDIT_NOTE_STATUSES)}::text[])
      AND (${dateFrom}::date IS NULL OR cn.credit_date >= ${dateFrom}::date)
      AND (${dateTo}::date IS NULL OR cn.credit_date <= ${dateTo}::date)

    ORDER BY transaction_date ASC, type ASC
  `) as Row[];

  let balance = openingBalance;
  const transactions: CustomerLedgerEntry[] = rows.map((row) => {
    const debit = Number(row.debit) || 0;
    const credit = Number(row.credit) || 0;
    balance = balance + debit - credit;
    return {
      type: row.type as LedgerEntryType,
      transactionId: String(row.transaction_id),
      reference: row.reference,
      transactionDate: toDateStr(row.transaction_date),
      debit,
      credit,
      status: row.status,
      balance,
    };
  });

  return {
    customerName: customerRows[0].name,
    openingBalance,
    closingBalance: balance,
    transactions,
  };
}
