/**
 * The pure rule for which GL accounts a supplier-bill line may name. Split from
 * `billLineAccountGuard.ts` (which reads the database) so the bill form can
 * offer exactly the set the server accepts. See the guard for the rationale.
 */
import { canonicalSubtype, isBankSubtype } from '../gl/accountSubtypes';
import { reportingClassFor } from '../gl/accountReportingClass';

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
