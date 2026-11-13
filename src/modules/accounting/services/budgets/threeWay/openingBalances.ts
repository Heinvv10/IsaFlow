/**
 * The opening balance sheet of a three-way run, bucketed (P6 spec §5, §13
 * items 8-10; decision 10a; T10). Read-only.
 *
 * `getBalanceSheet` lines carry an account code only (R3), so this is P6's own
 * read, with `fetchBalanceSheetData`'s predicates copied exactly: posted only,
 * the year-end close journal left out, `entry_date <= asAt`, asset / liability /
 * equity accounts, LEAF accounts only (level >= 3, or no child account), and
 * company_id on the lines, the entries, the accounts and the child probe.
 * Derived retained earnings is `calculateRetainedEarnings` (via `getEquityBases`,
 * the function the balance sheet injects from), added to `retainedEarnings`.
 * So the per-type totals equal `getBalanceSheet`'s (I7) and the buckets
 * balance by construction (§13.9) unless postings sit on header accounts.
 *
 * The cash check (I7, §13.8) compares the cash bucket with `getCashBalance`
 * (`exclusive` at the first month's 1st; at the as-at, inclusive, when the
 * opening is provisional). Its account set differs (cash subtypes at every
 * level, raw spellings, the year-end journal not excluded), so the check is per
 * ACCOUNT and reports each difference instead of forcing a match.
 */
import { sql, type DbRow } from '@/lib/neon';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getSystemAccountCandidates } from '@/modules/accounting/services/gl/systemAccountResolver';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { getEquityBases, type EquityBases } from '@/modules/accounting/services/reports/balanceSheetService';
import type { BalanceSheetType } from './bucketMap';
import { foldOpening, openingAsAt, type FoldedOpening, type OpeningAccountRow } from './threeWayFolds';

export interface OpeningRead extends FoldedOpening {
  asAt: string;
  provisional: boolean;
  /** Posted equity vs derived retained earnings (§13.9), cents. */
  equity: { posted: number; derivedRetainedEarnings: number };
  /** True when an inventory account carries a balance (inventory days are 0 otherwise). */
  holdsInventory: boolean;
}

export interface CashCheckAccount {
  accountCode: string;
  /** Cents in the cash bucket (null: not a leaf cash account on the balance sheet). */
  bucket: number | null;
  /** Cents per `getCashBalance` (null: not in its account set). */
  ledger: number | null;
}

export interface OpeningCashCheck {
  bucket: number;
  ledger: number;
  /** bucket − ledger, cents; 0 when the two account sets agree. */
  difference: number;
  /** Accounts whose two figures differ. */
  accounts: CashCheckAccount[];
}

const cents = (rand: number): number => {
  const c = Math.round(rand * 100);
  return c === 0 ? 0 : c;
};

async function readAccountBalances(companyId: string, asAt: string): Promise<OpeningAccountRow[]> {
  const rows = (await sql`
    SELECT ga.id::TEXT AS account_id, ga.account_code, ga.account_type, ga.account_subtype,
           ROUND(SUM(jl.debit - jl.credit) * 100)::BIGINT::TEXT AS net_cents
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
     WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
       AND je.company_id = ${companyId}::UUID
       AND jl.company_id = ${companyId}::UUID
       AND je.entry_date <= ${asAt}::DATE
       AND ga.account_type IN ('asset', 'liability', 'equity')
       AND (
         ga.level >= 3
         OR NOT EXISTS (
           SELECT 1 FROM gl_accounts child
            WHERE child.parent_account_id = ga.id AND child.company_id = ${companyId}::UUID
         )
       )
     GROUP BY ga.id, ga.account_code, ga.account_type, ga.account_subtype
     ORDER BY ga.account_code
  `) as DbRow[];
  return rows.map((r) => ({
    accountId: String(r.account_id).toLowerCase(),
    accountCode: String(r.account_code),
    accountType: String(r.account_type) as BalanceSheetType,
    accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
    netDebit: Number(r.net_cents),
  }));
}

/** Every account a loan names as its liability or current portion (company-scoped). */
export async function readLoanAccountIds(companyId: string): Promise<Set<string>> {
  const rows = (await sql`
    SELECT gl_account_id::TEXT AS a, current_portion_account_id::TEXT AS b
      FROM loans WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  const ids = new Set<string>();
  for (const r of rows) for (const v of [r.a, r.b]) if (v != null) ids.add(String(v).toLowerCase());
  return ids;
}

/** The system retained-earnings account, when exactly one claims the role (never throws when none does). */
async function retainedEarningsAccountId(companyId: string): Promise<string | null> {
  const found = await getSystemAccountCandidates('retained_earnings', companyId);
  return found.length === 1 ? String(found[0]!.id).toLowerCase() : null;
}

/** The bucketed opening for a version whose first month is `firstMonth` ('YYYY-MM'). */
export async function readOpening(companyId: string, firstMonth: string, today: string): Promise<OpeningRead> {
  const { asAt, provisional } = openingAsAt(firstMonth, today);
  const rows = await readAccountBalances(companyId, asAt);
  const bases: EquityBases = await getEquityBases(companyId, asAt);
  const derived = cents(bases.derivedRetainedEarnings);
  const folded = foldOpening(rows, derived, await readLoanAccountIds(companyId), await retainedEarningsAccountId(companyId));
  return {
    ...folded,
    asAt,
    provisional,
    equity: { posted: cents(bases.posted), derivedRetainedEarnings: derived },
    holdsInventory: folded.buckets.inventory !== 0,
  };
}

/** The opening cash bucket against `getCashBalance`, per account (I7, §13.8). */
export async function openingCashCheck(companyId: string, firstMonth: string, opening: OpeningRead): Promise<OpeningCashCheck> {
  const ledger = opening.provisional
    ? await getCashBalance(companyId, opening.asAt)
    : await getCashBalance(companyId, `${firstMonth}-01`, { exclusive: true });
  const byId = new Map<string, CashCheckAccount>();
  for (const [id, a] of opening.cashAccounts) byId.set(id, { accountCode: a.accountCode, bucket: a.balance, ledger: null });
  for (const a of ledger.accounts) {
    const id = a.accountId.toLowerCase();
    const seen = byId.get(id);
    if (seen) seen.ledger = cents(a.glBalance);
    else byId.set(id, { accountCode: a.accountCode, bucket: null, ledger: cents(a.glBalance) });
  }
  const accounts = [...byId.values()]
    .filter((a) => (a.bucket ?? 0) !== (a.ledger ?? 0))
    .sort((x, y) => x.accountCode.localeCompare(y.accountCode));
  const ledgerCents = cents(ledger.total);
  return { bucket: opening.buckets.cash, ledger: ledgerCents, difference: opening.buckets.cash - ledgerCents, accounts };
}
