/**
 * Settling a receivable or a payable against another GL account, without
 * inventing a bank payment that never happened.
 *
 * R371,470 of Brightsphere AP was settled in Sage by contra — netted against a
 * loan or intercompany account — and IsaFlow could not record it. The audit
 * called that a missing settlement path. The code says something narrower and
 * more useful: BOTH payment services resolve their cash leg as
 * `SELECT * FROM gl_accounts WHERE id = payment.bank_account_id`, with no
 * subtype check, and the column is a plain FK to `gl_accounts(id)`. The ledger
 * half has always worked. What was missing was the LABEL (migration 540 adds
 * `'contra'` to both `payment_method` checks) and the GUARDS that stop a contra
 * settlement being posted against something it must not be posted against.
 *
 * So this is a thin composition over the existing services rather than a fifth
 * implementation of "settle a document":
 *
 *   AR:  createCustomerPayment -> confirmCustomerPayment
 *        DR contra account / CR Accounts Receivable, and the invoice's
 *        amount_paid moves.
 *   AP:  createSupplierPayment -> approveSupplierPayment -> processSupplierPayment
 *        DR Accounts Payable / CR contra account, and the bill's amount_paid
 *        moves.
 *
 * THE GUARDS ARE THE NEW PART, and each is earned:
 *
 *   - the contra account must not be of subtype `bank`. Settling against a bank
 *     account IS the bank payment that never happened — the exact defect this
 *     exists to avoid — and it would move cash that nobody banked.
 *   - it must not be the subledger's own control account. DR AR / CR AR nets to
 *     nothing, balances perfectly, and silently settles the document against
 *     itself.
 *   - it must be in this company, and it must not be a parent header account
 *     (the balance sheet excludes headers, so a posting to one disappears from
 *     the statements).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getSystemAccount } from '../gl/systemAccountResolver';

export type Subledger = 'ar' | 'ap';

export interface ContraAccountCheck {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
}

/**
 * Validate the contra account for a settlement. READ-ONLY, so a caller that
 * must distinguish a refusal from a failure can run it before the first write.
 * Throws with the reason; returns the account when it is usable.
 */
export async function assertContraAccountUsable(
  companyId: string,
  subledger: Subledger,
  contraAccountId: string,
): Promise<ContraAccountCheck> {
  const rows = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.account_type,
           ga.account_subtype, ga.is_active,
           EXISTS (
             SELECT 1 FROM gl_accounts child
             WHERE child.parent_account_id = ga.id AND child.company_id = ga.company_id
           ) AS is_parent
    FROM gl_accounts ga
    WHERE ga.id = ${contraAccountId}::UUID AND ga.company_id = ${companyId}::UUID
  `) as DbRow[];
  // Same wording as a genuine miss: an account in another tenant must not be
  // distinguishable from one that does not exist.
  if (rows.length === 0) throw new Error(`Account ${contraAccountId} not found`);
  const account = rows[0]!;
  const code = String(account.account_code);
  const name = String(account.account_name);

  if (String(account.account_subtype ?? '') === 'bank') {
    throw new Error(
      `${code} ${name} is a BANK account. A contra settlement exists precisely because no cash `
      + 'moved — settling against a bank account records a payment that never happened, which is '
      + 'the defect this operation avoids. Use apply_receipt_to_invoice or '
      + 'apply_payment_to_supplier_invoice for a real bank movement.',
    );
  }
  if (account.is_parent === true) {
    throw new Error(
      `${code} ${name} is a parent header account with child accounts beneath it. The balance `
      + 'sheet excludes headers, so a posting to one is invisible in the statements. Post to a '
      + 'leaf account.',
    );
  }
  if (account.is_active === false) {
    throw new Error(
      `${code} ${name} is deactivated. Reactivate it with update_gl_account, or choose another.`,
    );
  }

  // The control account for the side being settled. DR AR / CR AR balances and
  // settles the invoice against itself; the reader sees a settled document and
  // an unchanged control account, which is exactly the reconciliation break the
  // programme exists to detect.
  const control = await getSystemAccount(subledger === 'ar' ? 'receivable' : 'payable', companyId);
  if (control.id === String(account.id)) {
    throw new Error(
      `${code} ${name} is the ${subledger === 'ar' ? 'Accounts Receivable' : 'Accounts Payable'} `
      + 'control account itself. Settling a document against its own control account nets to '
      + 'nothing and leaves the subledger and the GL disagreeing by the amount settled.',
    );
  }

  return {
    accountId: String(account.id),
    accountCode: code,
    accountName: name,
    accountType: String(account.account_type),
  };
}

export interface ContraDocument {
  documentId: string;
  documentNumber: string;
  counterpartyId: string;
  totalAmount: number;
  amountPaid: number;
  outstanding: number;
  status: string;
}

/** A cent. */
const EPS = 0.01;

const UNSETTLEABLE = new Set(['cancelled', 'draft']);

/**
 * Read the document being settled and refuse anything that cannot take a
 * settlement. READ-ONLY.
 *
 * `COALESCE(ci.client_id, ci.customer_id)` on the AR side: both columns exist
 * on `customer_invoices` and either may be the populated one.
 */
export async function loadContraDocument(
  companyId: string,
  subledger: Subledger,
  documentId: string,
  amount: number,
): Promise<ContraDocument> {
  const rows = subledger === 'ar'
    ? ((await sql`
        SELECT ci.id, ci.invoice_number,
               COALESCE(ci.client_id, ci.customer_id) AS counterparty_id,
               ci.total_amount, ci.amount_paid, ci.status
        FROM customer_invoices ci
        WHERE ci.id = ${documentId}::UUID AND ci.company_id = ${companyId}::UUID
      `) as DbRow[])
    : ((await sql`
        SELECT si.id, si.invoice_number,
               si.supplier_id AS counterparty_id,
               si.total_amount, si.amount_paid, si.status
        FROM supplier_invoices si
        WHERE si.id = ${documentId}::UUID AND si.company_id = ${companyId}::UUID
      `) as DbRow[]);

  if (rows.length === 0) throw new Error(`Invoice ${documentId} not found`);
  const row = rows[0]!;
  const status = String(row.status);
  const number = String(row.invoice_number);
  if (UNSETTLEABLE.has(status)) {
    throw new Error(`Invoice ${number} is ${status} and cannot be settled.`);
  }
  const counterpartyId = row.counterparty_id ? String(row.counterparty_id) : null;
  if (!counterpartyId) {
    throw new Error(
      `Invoice ${number} names no ${subledger === 'ar' ? 'customer' : 'supplier'}, so a `
      + 'settlement cannot be attributed to one.',
    );
  }

  const totalAmount = Number(row.total_amount);
  const amountPaid = Number(row.amount_paid ?? 0);
  const outstanding = round2(totalAmount - amountPaid);
  if (amount > outstanding + EPS) {
    throw new Error(
      `R${amount.toFixed(2)} exceeds the R${outstanding.toFixed(2)} outstanding on invoice `
      + `${number}.`,
    );
  }

  return {
    documentId: String(row.id),
    documentNumber: number,
    counterpartyId,
    totalAmount,
    amountPaid,
    outstanding,
    status,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
