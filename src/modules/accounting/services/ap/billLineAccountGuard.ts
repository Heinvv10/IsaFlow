/**
 * Which GL accounts a supplier-bill line may name.
 *
 * A bill line is the debit side of DR <line account> / CR Accounts Payable, so
 * it must be an account that debit can mean. Refused:
 *
 *  - AP and AR control (`payable` / `receivable`, any spelling the
 *    canonicaliser folds onto them): a line on AP cancels the bill's own
 *    credit, and one on AR puts a supplier's bill into the debtors book.
 *    Every account with the subtype, not just the resolver's: the subledger
 *    reconciliation counts them all as control.
 *  - Sage's control and system accounts SYS-7/8/9/10/13/15/24 (Trade
 *    Receivables, Trade Payables, VAT Payable, VAT Provision, Opening Balance
 *    and VAT Adjustments, System Rounding, DRC VAT Payable). Imported charts
 *    carry them live with a NULL or generic subtype — Velocity's SYS-8 holds
 *    R37.7m — so no subtype rule sees them. Sage's codes are fixed
 *    identifiers, which is why this one rule reads account_code.
 *  - bank: `bank_transactions` reach their account through that subtype, so a
 *    bill line there moves a balance the reconciliation will never explain.
 *  - the VAT class (`reportingClassFor`): the VAT return reads every line on
 *    those accounts by RAW subtype, and a line with no `vat_type` is swept
 *    into box 15 at full value. Raw on purpose — canonicalising turns `tax`
 *    into `tax_expense` and would stop matching what the return reads. Input
 *    VAT on a bill comes from the line's tax rate, never from a line.
 *  - opening balance equity, retained earnings and accumulated depreciation:
 *    written only by the opening TB, year-end close and depreciation runs.
 *  - a header (an account with children in the same company) and an inactive
 *    account: both are hidden from the pickers for exactly this reason.
 *  - another company's account: `gl_account_id` is a plain FK that bypasses
 *    RLS. The message matches `accountsBelongToCompany`'s callers, so no reply
 *    says whether a foreign id exists.
 *
 * One query for any number of lines, taking FOR SHARE on the accounts — in id
 * order WITHIN the call, the order `lockGlAccountsForUpdate` (merge) takes
 * them; a batch that calls this once per bill in one transaction (bulk
 * approve, bulk Post to GL) accumulates locks in bill order, so a concurrent
 * merge can still deadlock it (40P01, the batch rolls back) — so a
 * reclassification or deactivation cannot land between this check and the
 * caller's write in the same request transaction. It does NOT stop a new
 * child account being created under one (that takes FOR KEY SHARE, which does
 * not conflict), so the header test is as of the read.
 *
 * Checked when a line is coded AND when the bill posts (approve, Post to GL):
 * an account can be reclassified or gain children after the line names it.
 */
import { sql } from '@/lib/neon';
import type { SupplierInvoice } from '../../types/ap.types';
import { canonicalSubtype, isBankSubtype } from '../gl/accountSubtypes';
import { reportingClassFor } from '../gl/accountReportingClass';
import { assertPostsStoredDimensions } from '../gl/dimensions/dimensionStoredPosting';

/** Raised by the throwing forms; the code lets its message reach an MCP caller. */
export class BillLineAccountRefusal extends Error {
  readonly code = 'BILL_LINE_ACCOUNT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'BillLineAccountRefusal';
  }
}

export const FOREIGN_LINE_ACCOUNT = 'One or more lines[].gl_account_id values are not GL accounts in your company.';

const SAGE_CONTROL_CODES: ReadonlySet<string> = new Set(['SYS7', 'SYS8', 'SYS9', 'SYS10', 'SYS13', 'SYS15', 'SYS24']);
const SYSTEM_ONLY_SUBTYPES: ReadonlySet<string> = new Set([
  'opening_balance_equity', 'retained_earnings', 'accumulated_depreciation',
]);

export interface BillLineAccountRow {
  account_code: string;
  account_name: string;
  account_subtype: string | null;
  is_active: boolean;
  has_children: boolean;
}

/** Why a bill line may not name this account, or null when it may. */
export function billLineAccountProblem(a: BillLineAccountRow): string | null {
  const canonical = canonicalSubtype(a.account_subtype);
  if (canonical === 'payable' || canonical === 'receivable') {
    return 'is an Accounts Payable or Receivable control account';
  }
  if (SAGE_CONTROL_CODES.has(a.account_code.replace(/-/g, '').toUpperCase())) {
    return 'is a Sage control or system account (debtors, creditors, VAT, opening balances or rounding)';
  }
  if (isBankSubtype(a.account_subtype)) return 'is a bank account';
  if (reportingClassFor(a.account_subtype) === 'vat') {
    return `has subtype ${a.account_subtype}, which the VAT return reads — a bill line there lands on the return`;
  }
  if (canonical && SYSTEM_ONLY_SUBTYPES.has(canonical)) {
    return 'is written only by the opening balances, year-end close or depreciation';
  }
  if (a.has_children) return 'is a header account with sub-accounts; choose one of those';
  if (!a.is_active) return 'is inactive';
  return null;
}

export async function billLineAccountRefusal(
  companyId: string,
  accountIds: readonly (string | null | undefined)[],
): Promise<string | null> {
  // Lower-cased: Postgres reads 'ABC…' and 'abc…' as one uuid and returns one row.
  const unique = [...new Set(accountIds
    .filter((id): id is string => typeof id === 'string' && id !== '')
    .map((id) => id.toLowerCase()))];
  if (unique.length === 0) return null;
  const rows = (await sql`
    SELECT a.id, a.account_code, a.account_name, a.account_subtype, a.is_active,
           EXISTS (SELECT 1 FROM gl_accounts c
                   WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
    FROM gl_accounts a
    WHERE a.company_id = ${companyId}::UUID AND a.id = ANY(${unique}::UUID[])
    ORDER BY a.id
    FOR SHARE OF a
  `) as BillLineAccountRow[];
  return rows.length !== unique.length ? FOREIGN_LINE_ACCOUNT : firstRefusal(rows);
}

/** The ONE ordering both entry points report by: first refused account by code. */
function firstRefusal(rows: readonly BillLineAccountRow[]): string | null {
  for (const row of [...rows].sort((x, y) => x.account_code.localeCompare(y.account_code))) {
    const refusal = refusalText(row);
    if (refusal) return refusal;
  }
  return null;
}

function refusalText(row: BillLineAccountRow): string | null {
  const problem = billLineAccountProblem(row);
  return problem ? `A bill line cannot be coded to ${row.account_code} ${row.account_name}: it ${problem}.` : null;
}

const POSTING_HINT = ' Recode the line on the draft, or cancel the bill and re-enter it.';

/**
 * The same test over bills' STORED lines, read-only and per bill, for a batch
 * that skips what it cannot post (bulk approve) so its dry run and its live
 * call decide alike, with the reason approve would give. A bill that already
 * carries a journal is left out: approve reuses that journal without posting.
 * The posting path re-checks under lock regardless.
 */
export async function supplierInvoiceLineAccountRefusals(
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, string>> {
  const refusals = new Map<string, string>();
  if (invoiceIds.length === 0) return refusals;
  const rows = (await sql`
    SELECT si.id AS invoice_id, si.invoice_number, a.account_code, a.account_name,
           a.account_subtype, a.is_active, (a.id IS NULL) AS missing,
           EXISTS (SELECT 1 FROM gl_accounts c
                   WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
    FROM supplier_invoices si
    JOIN supplier_invoice_items sii ON sii.supplier_invoice_id = si.id AND sii.gl_account_id IS NOT NULL
    LEFT JOIN gl_accounts a ON a.id = sii.gl_account_id AND a.company_id = si.company_id
    WHERE si.company_id = ${companyId}::UUID AND si.id = ANY(${[...invoiceIds]}::UUID[])
      AND si.gl_journal_entry_id IS NULL
  `) as (BillLineAccountRow & { invoice_id: string; invoice_number: string; missing: boolean })[];
  const byBill = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = String(row.invoice_id);
    byBill.set(id, [...(byBill.get(id) ?? []), row]);
  }
  for (const [id, lines] of byBill) {
    const refusal = lines.some((l) => l.missing) ? FOREIGN_LINE_ACCOUNT : firstRefusal(lines);
    if (refusal) refusals.set(id, `Supplier invoice ${lines[0]!.invoice_number}: ${refusal}${POSTING_HINT}`);
  }
  return refusals;
}

/** The throwing form, for services whose callers turn a thrown message into a 4xx. */
export async function assertBillLineAccounts(
  companyId: string,
  accountIds: readonly (string | null | undefined)[],
): Promise<void> {
  const refusal = await billLineAccountRefusal(companyId, accountIds);
  if (refusal) throw new BillLineAccountRefusal(refusal);
}

/**
 * For the posting paths: the stored lines, re-checked against the chart as it
 * is now — and their CC1 / CC2 / BU posted as stored, never re-derived from a
 * project's current FNO (dimensionStoredPosting, migration 873).
 */
export async function assertSupplierInvoiceLinesPostable(
  companyId: string,
  invoice: Pick<SupplierInvoice, 'invoiceNumber' | 'items'>,
): Promise<void> {
  const refusal = await billLineAccountRefusal(companyId, (invoice.items ?? []).map((i) => i.glAccountId));
  if (refusal) throw new BillLineAccountRefusal(`Supplier invoice ${invoice.invoiceNumber}: ${refusal}${POSTING_HINT}`);
  await assertPostsStoredDimensions(companyId, invoice.items ?? [], (i) => `Supplier invoice ${invoice.invoiceNumber} line ${i + 1}`);
}
