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
import { GL_ACCOUNT_SUBTYPES_BY_TYPE } from '../../types/glAccountSubtypes';
import { isBankSubtype } from '../gl/accountSubtypes';

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

  assertBalanceSheetAccount(account, code, name);

  if (isBankSubtype(account.account_subtype == null ? null : String(account.account_subtype))) {
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
  // `is_active` is a PICKER flag: it says whether an account should be OFFERED
  // for a new posting, and nothing whatever about whether it holds money. It is
  // read here — where the question genuinely is "may I post to this?" — and
  // must never be used to filter a balance or a total. Four deactivated
  // accounts in these books hold R137,317.39 between them, and a report that
  // filtered on this flag would simply lose them.
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

/**
 * The two sides of the chart, by `account_type`. A contra settles one party's
 * balance against ANOTHER BALANCE-SHEET POSITION — a loan, an intercompany
 * account, a director's account.
 */
const BALANCE_SHEET_TYPES = new Set(['asset', 'liability', 'equity']);
const INCOME_STATEMENT_TYPES = new Set(['revenue', 'expense']);

/**
 * Refuse anything that is not a balance-sheet position.
 *
 * SETTLING AGAINST AN EXPENSE OR REVENUE ACCOUNT IS A WRITE-OFF, NOT A CONTRA.
 * `ar/writeOffService` already does that, with its own approval flow and its
 * own GL treatment. Letting it through here would put a write-off somewhere
 * plausible and wrong — R371,470 landing in a cost account that nobody would
 * think to question, because the document really would come out settled.
 *
 * THE CLASSIFICATION IS STRUCTURAL, NEVER BY NAME OR CODE. Two accounts typed
 * `default_expense` overstated gross profit by R562,428 in these books because
 * a bucket was chosen by account NAME. An account called "Bad Debts Written
 * Off" that is typed as a liability IS a balance-sheet position, and the name
 * is not evidence of anything.
 *
 * The subtype is validated against `GL_ACCOUNT_SUBTYPES_BY_TYPE` rather than
 * merely read, because `account_subtype` is plain TEXT with no CHECK: a typo
 * writes fine and then behaves exactly like NULL. An account that cannot be
 * classified is REFUSED rather than classified from its `account_type` alone —
 * guessing here would be the same failure one level down, and the remedy
 * (`update_gl_account`) is cheap and leaves a trail.
 */
function assertBalanceSheetAccount(account: DbRow, code: string, name: string): void {
  const type = String(account.account_type ?? '');
  const subtype = account.account_subtype ? String(account.account_subtype) : null;

  const legalSubtypes = (GL_ACCOUNT_SUBTYPES_BY_TYPE as Record<string, readonly string[]>)[type];
  if (!legalSubtypes || !subtype || !legalSubtypes.includes(subtype)) {
    throw new Error(
      `${code} ${name} carries account_type "${type || '(none)'}" and account_subtype `
      + `"${subtype ?? '(none)'}", which is not a valid pairing — so it cannot be classified as a `
      + 'balance-sheet or an income-statement account, and a contra settlement must not guess. '
      + 'Fix the account with update_gl_account, then retry.',
    );
  }

  if (INCOME_STATEMENT_TYPES.has(type)) {
    throw new Error(
      `${code} ${name} is an income-statement account (${type} / ${subtype}). A contra settles a `
      + 'balance against another BALANCE-SHEET position — a loan, an intercompany or a '
      + "director's account. Netting a debt against income or expense is a WRITE-OFF, not a "
      + 'contra, and it has its own treatment: use write_off (POST /api/accounting/write-offs).',
    );
  }

  if (!BALANCE_SHEET_TYPES.has(type)) {
    throw new Error(
      `${code} ${name} has an unrecognised account_type "${type}". Fix it with update_gl_account.`,
    );
  }
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
