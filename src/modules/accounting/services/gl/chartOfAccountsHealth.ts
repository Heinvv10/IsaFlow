/**
 * The chart of accounts as an object of audit.
 *
 * `chartOfAccountsService` is CRUD: it lists accounts and edits them. Nothing
 * anywhere asks whether the chart itself is sound, and on both live companies
 * it is not. Brightsphere is running an imported Sage chart and the system
 * chart on top of each other, so two accounts receive the postings one payables
 * control should and every resolver picks one of them — which is how AP
 * movement came out as R0. Velocity has eight cost-of-sales accounts with no
 * subtype at all, which is why R81m of them is reported as operating expenses
 * and gross profit is wrong.
 *
 * None of that makes a trial balance unbalance. That is exactly why it survives
 * and why it needs a report of its own.
 *
 * The classification is a pure function so the rules can be read and tested
 * without a database. The SQL that feeds it lives in
 * `chartOfAccountsHealthQuery.ts`.
 */
import { typeFitsSubtype } from './systemAccountResolver';

export interface ChartAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  isActive: boolean;
  isSystemAccount: boolean;
  /** Non-null when the account came from an import (Sage, Xero, a CSV). */
  importedFrom: string | null;
  /** Posted journal lines against this account, ever. */
  postedLines: number;
  /** Posted balance, debits positive. */
  balance: number;
}

/** Machine-stable finding codes. Callers branch on these. */
export const ACCOUNT_FINDINGS = [
  'no_subtype',
  'subtype_does_not_fit_type',
  'never_posted',
  'inactive_with_balance',
] as const;

export type AccountFinding = (typeof ACCOUNT_FINDINGS)[number];

/**
 * What is wrong with one account, if anything.
 *
 * `no_subtype` is first because it is the one that silently misplaces money:
 * the income statement buckets by subtype, the VAT201 resolves VAT accounts by
 * subtype, and the system account resolver reads nothing else. An account with
 * no subtype is invisible to all three and lands in whatever the default bucket
 * happens to be.
 */
export function classifyAccount(account: ChartAccount): AccountFinding[] {
  const findings: AccountFinding[] = [];

  if (account.accountSubtype === null || account.accountSubtype === '') {
    findings.push('no_subtype');
  } else if (!typeFitsSubtype(account.accountType, account.accountSubtype)) {
    // Production carries `vat_input` on a LIABILITY. Every rule that reads
    // account_type misreads it, and the VAT201 nearly dropped 356 lines on it.
    findings.push('subtype_does_not_fit_type');
  }

  if (account.postedLines === 0) findings.push('never_posted');

  // A deactivated account with a balance is still on the balance sheet, and any
  // report that filters `is_active` drops it — which is how a Caseware export
  // went out of balance by exactly the R130,000 sitting on one dormant account.
  if (!account.isActive && Math.abs(account.balance) > 0.005) {
    findings.push('inactive_with_balance');
  }

  return findings;
}

/**
 * Collapse a name to a comparison key: case, punctuation and repeated spaces
 * are noise, and "Trade Debtors Control" and "trade debtors-control" are one
 * account entered twice.
 */
export function normaliseAccountName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface DuplicateGroup {
  /** The code, or the normalised name, that more than one account shares. */
  key: string;
  accountIds: string[];
  /** Codes of the accounts in the group, so the reader can see them. */
  accountCodes: string[];
  /** Posted lines across the group — which of them is actually in use. */
  postedLines: number;
}

export interface ChartHealthSummary {
  accountsTotal: number;
  accountsWithFindings: number;
  findingCounts: Record<AccountFinding, number>;
  duplicateCodes: DuplicateGroup[];
  duplicateNames: DuplicateGroup[];
  /** Accounts that came from an import. */
  importedAccounts: number;
  /** Accounts the system created. */
  systemAccounts: number;
  /**
   * True when both an imported chart and a system chart are present. Neither is
   * wrong on its own; together they mean two accounts exist for several roles
   * and every resolver silently picks one.
   */
  overlaidCharts: boolean;
}

function group(accounts: readonly ChartAccount[], keyOf: (a: ChartAccount) => string): DuplicateGroup[] {
  const buckets = new Map<string, ChartAccount[]>();
  for (const a of accounts) {
    const key = keyOf(a);
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(a);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({
      key,
      accountIds: list.map((a) => a.id),
      accountCodes: list.map((a) => a.accountCode),
      postedLines: list.reduce((s, a) => s + a.postedLines, 0),
    }))
    .sort((a, b) => b.postedLines - a.postedLines || a.key.localeCompare(b.key));
}

export function summariseChart(accounts: readonly ChartAccount[]): ChartHealthSummary {
  const findingCounts = Object.fromEntries(
    ACCOUNT_FINDINGS.map((f) => [f, 0]),
  ) as Record<AccountFinding, number>;

  let accountsWithFindings = 0;
  for (const a of accounts) {
    const findings = classifyAccount(a);
    if (findings.length > 0) accountsWithFindings++;
    for (const f of findings) findingCounts[f]++;
  }

  const importedAccounts = accounts.filter((a) => a.importedFrom !== null).length;
  const systemAccounts = accounts.filter((a) => a.isSystemAccount).length;

  return {
    accountsTotal: accounts.length,
    accountsWithFindings,
    findingCounts,
    duplicateCodes: group(accounts, (a) => a.accountCode),
    duplicateNames: group(accounts, (a) => normaliseAccountName(a.accountName)),
    importedAccounts,
    systemAccounts,
    overlaidCharts: importedAccounts > 0 && systemAccounts > 0,
  };
}
