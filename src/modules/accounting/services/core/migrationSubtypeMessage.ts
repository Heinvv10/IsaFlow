/**
 * Pure banding and wording for the "account subtype coverage" go-live check.
 * The DB half lives in `./migrationSubtypeCheck.ts`, which carries the WHY.
 *
 * Everything here is deliberately pure so the decisions that matter — which
 * accounts count, what the total means, and what the operator is told it costs
 * — are unit-testable and mutation-testable rather than buried in SQL.
 */

import { canonicalSubtype } from '../gl/accountSubtypes';
import type { ValidationResult } from './migrationValidationService';

/** One account's `account_subtype` and its posted movement. */
export interface AccountMovementRow {
  account_code: string;
  account_name: string;
  account_type: string;
  account_subtype: string | null;
  /** `SUM(debit - credit)` over posted lines. pg returns NUMERIC as a string. */
  net: number | string | null;
  /** `SUM(debit + credit)` — movement that a nil net balance hides. */
  gross: number | string | null;
}

export const SUBTYPE_COVERAGE_CHECK = 'Account Subtype Coverage';

/** Below half a cent is rounding dust, not movement. */
const MATERIAL = 0.005;

/** How many accounts to name before summarising the rest. */
const NAMED_LIMIT = 5;

/**
 * Account types where a missing subtype defaults NOTHING, so there is nothing
 * to report. Equity has no sub-split in `aggregateFigures` — an equity account
 * lands in `totalEquity` on `account_type` alone. `DEFAULTED_WHEN_UNKNOWN` in
 * `../gl/accountClassification.ts` makes the same exclusion for the same
 * reason; the two must not drift.
 */
const NO_DEFAULT_TYPES: ReadonlySet<string> = new Set(['equity']);

/**
 * What the fallback DOES, per account type — the mechanism, never an asserted
 * error. Stating "overstates working capital" as fact is wrong for the two
 * largest accounts in the live population: Velocity's `SYS-7 Trade Receivables`
 * (R32.7m) and `SYS-8 Trade Payables` (R37.7m) default to current asset and
 * current liability, which is exactly where they belong — what is actually
 * lost on those two is the `accountsReceivable` / `accountsPayable` memo lines.
 * Whether a default is WRONG is knowable only per account, by a person who
 * knows what the account is for. So say what happens, and where it bites.
 */
const FALLBACK_BY_TYPE: Record<string, string> = {
  expense:
    'defaults to operating expenses, so a cost-of-sales account overstates gross profit',
  asset:
    'defaults to CURRENT assets and is dropped from cash, receivables and inventory — right for a trade receivable, wrong for a fixed asset or a bank account',
  liability:
    'defaults to CURRENT liabilities and is dropped from accounts payable — wrong for any long-term loan',
  revenue: 'defaults to turnover, so other income is reported as revenue',
};

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

/** `1234567.5` → `R1,234,567.50`. Deterministic; no locale dependency. */
export function formatRand(value: number): string {
  const fixed = Math.abs(value).toFixed(2);
  const [whole = '0', cents = '00'] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}R${grouped}.${cents}`;
}

/** `a`/`an`, so the operator-facing sentence reads like English. */
const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/**
 * An account type this file has no mapping for is reported LOUDLY, not dropped:
 * a type outside the five is banded by nothing at all, which is worse than a
 * wrong band and must not vanish because no wording was written for it.
 */
function fallbackFor(accountType: string): string {
  const known = FALLBACK_BY_TYPE[accountType];
  return `${article(accountType)} ${accountType} account with no subtype ${
    known ?? 'is not banded by any report'
  }`;
}

/**
 * Is this account's subtype unusable? `canonicalSubtype` is the SAME function
 * `aggregateFigures` bands with, so this cannot drift from what the reports
 * actually do — and it catches three cases `IS NULL` misses: the empty string,
 * whitespace, and a real spelling the alias table does not know. Production
 * carries two of the last kind (`other`, `disposal_profit_loss`), one of them
 * on a R3.05m long-term loan.
 */
export const isUnbanded = (row: AccountMovementRow): boolean =>
  !NO_DEFAULT_TYPES.has(row.account_type) && canonicalSubtype(row.account_subtype) === null;

function nameAccounts(rows: readonly { account_code: string; account_name: string; account_type: string; amount: number }[]): string {
  const named = rows
    .slice(0, NAMED_LIMIT)
    .map(r => `${r.account_code} ${r.account_name} (${r.account_type}) ${formatRand(r.amount)}`);
  const remaining = rows.length - named.length;
  if (remaining > 0) named.push(`and ${remaining} more`);
  return named.join('; ');
}

/**
 * Band the rows into a validation result.
 *
 * Warns, never fails: this is an exceptions report, on the same footing as the
 * VAT-on-balance-sheet report. The trial balance still balances; what is wrong
 * is where the money is REPORTED, which a person has to adjudicate account by
 * account. Blocking go-live on it would stop a migration nobody can unblock
 * without that adjudication.
 */
export function buildSubtypeCoverageResult(
  rows: readonly AccountMovementRow[],
): ValidationResult {
  const unbanded = rows
    .filter(isUnbanded)
    .map(r => ({ ...r, amount: num(r.net), moved: Math.abs(num(r.gross)) }));

  const flagged = unbanded
    .filter(r => Math.abs(r.amount) >= MATERIAL)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  // Movement a nil net balance hides. Velocity's `1564412 ABSA - PC` is a BANK
  // account with 18 posted lines, no subtype and a zero balance — so it is
  // absent from `f.cash` and from getBankAccountsStatus, and the balance check
  // above cannot see it. Reported separately rather than folded into the count:
  // a rollup heading that nets to nil is noise, a dormant bank account is not,
  // and only a person can tell them apart.
  const dormant = unbanded
    .filter(r => Math.abs(r.amount) < MATERIAL && r.moved >= MATERIAL)
    .sort((a, b) => b.moved - a.moved);

  if (flagged.length === 0 && dormant.length === 0) {
    return {
      check: SUBTYPE_COVERAGE_CHECK,
      status: 'pass',
      message: 'Every account carrying value has a recognised account_subtype',
    };
  }

  const dormantNote =
    dormant.length === 0
      ? ''
      : ` Plus ${dormant.length} account(s) whose posted movement nets to nil, so no balance appears above and nothing is totalled — ` +
        `${nameAccounts(dormant.map(r => ({ ...r, amount: r.moved })))}. ` +
        'Still unbanded, and still wrong on any date between the legs.';

  if (flagged.length === 0) {
    return {
      check: SUBTYPE_COVERAGE_CHECK,
      status: 'warn',
      message:
        `No account carries an unclassified balance, but ${dormant.length} account(s) with posted movement have no usable account_subtype.` +
        dormantNote,
    };
  }

  const total = flagged.reduce((sum, r) => sum + Math.abs(r.amount), 0);
  const types = [...new Set(flagged.map(r => r.account_type))].sort();

  const byType = types
    .map(t => {
      const of = flagged.filter(r => r.account_type === t);
      return `${t} ${of.length} (${formatRand(of.reduce((s, r) => s + Math.abs(r.amount), 0))})`;
    })
    .join(', ');

  return {
    check: SUBTYPE_COVERAGE_CHECK,
    status: 'warn',
    message:
      `${flagged.length} account(s) carrying ${formatRand(total)} have no usable account_subtype. ` +
      'They are not left out of the reports — they are silently defaulted: ' +
      `${types.map(fallbackFor).join('; ')}. Set a subtype on each before anyone reads a report.`,
    detail:
      `By type: ${byType}. ` +
      `Largest: ${nameAccounts(flagged)}.` +
      dormantNote +
      ` The total is the sum of ABSOLUTE per-account balances — a magnitude of what is unclassified, ` +
      'not a figure any report shows: it adds income-statement flows to balance-sheet balances and counts both legs of a misposting.',
  };
}
