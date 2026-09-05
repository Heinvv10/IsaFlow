/**
 * VAT exception: a VAT code claimed against an account where no supply exists.
 *
 * Sibling of vatBalanceSheetExceptions.ts, and the two do NOT overlap by
 * accident. That rule asks "is the contra leg on the wrong side of the
 * statements?" and excludes fixed assets, stock and prepayments because a real
 * supply is merely being capitalised. This rule asks a different question —
 * "could a supply have happened here at all?" — and the answer is no for
 * salaries, statutory deductions, taxes, dividends, depreciation, donations
 * and exempt financial services. Neither rule catches the other's cases:
 * production's worst instance is an income-statement account (invisible to the
 * balance-sheet rule) and its second is subtype `fixed_assets` (explicitly
 * excluded there).
 *
 * WHY THIS EXISTS — the production finding, 2026-09-05
 * -----------------------------------------------------
 * Velocity Fibre `49784360 Salaries & Wages` carried 29 posted journals, all
 * from `auto_bank_recon`, in which each salary payment was allocated
 * VAT-exclusive:
 *
 *     bank credit 3 069 642,51 = expense 2 669 254,37 + VAT Input 400 388,14
 *
 * Exactly 15%. Employment is not an enterprise and salaries are not a supply,
 * so R400 388,14 of input tax was manufactured and the salary cost understated
 * by the same amount. The VAT legs sit on a `vat_input` account coded
 * `standard`, so vatReturnService puts them in box 15 — a real VAT201 number,
 * not a label. Brightsphere `35948127 Investment - Blitz Fibre` is the same
 * mistake on the output side: R9 782,61 of output tax on the disposal of a
 * share investment, an exempt financial service.
 *
 * Nothing in the codebase would have reported either. `vat_input_denied`
 * exists but encodes s17(2)(a) entertainment DENIAL, which is a different fact
 * — there a supply happens and the claim is refused; here no supply happens at
 * all. inputVatDenial.ts already warns against conflating the two.
 *
 * INFORMATIONAL ONLY. Same altitude, and the same reasoning, as the
 * balance-sheet rule: it reports before filing and blocks no posting.
 *
 * WHY IT MATCHES ON NAME, NOT SUBTYPE
 * ------------------------------------
 * Because subtype does not carry the fact. The R400k account has a NULL
 * `account_subtype` in production, and `payroll_liability` covers the PAYE/UIF
 * side but nothing names the salary expense itself. A subtype-driven version of
 * this rule would have found zero of the two known defects. The eventual home
 * for this is a stored per-account marker set from the Chart of Accounts
 * screen; until one exists and someone populates it, a marker nobody has filled
 * in reports nothing — which is precisely how `vat_input_denied` sat unused
 * while R400k accumulated.
 *
 * Verified against production before shipping: across all tenants these
 * patterns match 111 accounts, and of the posted VAT-coded lines on them
 * exactly the two defects above are flagged. Every other standard-rated account
 * in the ledger — bank charges, short-term insurance, travel, entertainment —
 * is deliberately absent from the patterns because those ARE supplies.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { dateStr, r2, toNum } from './vatExceptionsTypes';
import type { NonSupplyReason, VatNonSupplyLine } from './vatExceptionsTypes';

/**
 * VAT codes that make no claim, so carry no defect on a non-supply account.
 *
 * `exempt` is here and is load-bearing: interest received and financial
 * services are exactly the accounts this rule matches, and coding them
 * `exempt` is the CORRECT treatment. Without this exclusion the rule would
 * flag every properly-coded interest account in the platform.
 */
export const NON_CLAIMING_VAT_TYPES: readonly string[] = ['no_vat', 'exempt'];

/**
 * Ordered account-name patterns, first match wins.
 *
 * POSIX regex, matched case-insensitively against `gl_accounts.account_name`
 * by both `classifyNonSupplyAccount` below and the SQL at the bottom of this
 * file — they share these strings so the two cannot drift.
 *
 * Word-boundary anchors (`\m`, `\M`) on the short acronyms only: bare `paye`
 * would otherwise match inside longer words, while `salar` is deliberately a
 * stem so it takes "Salary" and "Salaries" both.
 */
export const NON_SUPPLY_PATTERNS: ReadonlyArray<{ reason: NonSupplyReason; pattern: string }> = [
  // Employment is excluded from "enterprise" (VAT Act s1), so no supply arises
  // on remuneration or on the statutory deductions that ride with it.
  { reason: 'employment_cost', pattern: 'salar|wage|payroll|\\mpaye\\M|\\muif\\M|\\msdl\\M|leave pay' },
  // Taxes, fines and penalties are imposed, not supplied.
  { reason: 'tax_or_penalty', pattern: 'income tax|provisional tax|\\mfines?\\M|penalt' },
  // A distribution to owners is not consideration for anything.
  { reason: 'distribution', pattern: 'dividend|drawings' },
  // An internal allocation with no counterparty and no transaction.
  { reason: 'depreciation', pattern: 'deprecia|amorti[sz]' },
  // Given without consideration, so outside the scope of VAT.
  { reason: 'donation', pattern: 'donation' },
  // Exempt financial services (VAT Act s12(a)): interest, and the issue,
  // holding or disposal of shares and loans.
  { reason: 'financial_service', pattern: 'interest|investment|\\mloan' },
];

/** The union of every pattern above — what the SQL filters on. */
export const NON_SUPPLY_PATTERN = NON_SUPPLY_PATTERNS.map((p) => p.pattern).join('|');

/**
 * Rewrite a POSIX pattern for JavaScript's regex engine.
 *
 * The patterns are authored for Postgres because the SQL is what runs against
 * the ledger. Postgres spells a word boundary `\m` (start), `\M` (end) and
 * `\y` (either); JavaScript spells all three `\b` — and, worse, treats `\m`
 * as an identity escape for a literal "m" rather than erroring, so an
 * untranslated pattern silently matches nothing. `\mpaye\M` in JS is the
 * literal string "mpayeM", which is how a PAYE account would have slipped
 * through the pure predicate while the SQL flagged it.
 */
export function toJsRegExp(posixPattern: string): RegExp {
  return new RegExp(posixPattern.replace(/\\[mMy]/g, '\\b'), 'i');
}

const COMPILED = NON_SUPPLY_PATTERNS.map(
  ({ reason, pattern }) => ({ reason, re: toJsRegExp(pattern) }),
);

/**
 * Why this account can never carry VAT, or null if it can.
 *
 * Pure, exported and tested directly, so the rule can be exercised with no
 * database and so a pattern change is visible in one place.
 */
export function classifyNonSupplyAccount(accountName: string): NonSupplyReason | null {
  for (const { reason, re } of COMPILED) {
    if (re.test(accountName)) return reason;
  }
  return null;
}

/** The rule, as a pure predicate over one posted line. */
export function isNonSupplyVatException(line: {
  accountName: string;
  vatType: string | null;
}): boolean {
  if (line.vatType === null || NON_CLAIMING_VAT_TYPES.includes(line.vatType)) return false;
  return classifyNonSupplyAccount(line.accountName) !== null;
}

export function mapVatNonSupplyLine(r: DbRow): VatNonSupplyLine {
  const accountName = String(r.account_name ?? '');
  return {
    journalEntryId: String(r.journal_entry_id),
    entryNumber: String(r.entry_number ?? ''),
    entryDate: dateStr(r.entry_date),
    accountCode: String(r.account_code ?? ''),
    accountName,
    // Classified here rather than in SQL so the ordered pattern list stays the
    // single source of truth. Null is unreachable while the SQL filters on the
    // union of the same patterns; it is typed anyway rather than defaulted to a
    // category, so a future divergence shows as a blank reason instead of a
    // confidently wrong one.
    reason: classifyNonSupplyAccount(accountName),
    vatType: String(r.vat_type ?? ''),
    description: String(r.description ?? ''),
    amount: r2(toNum(r.amount)),
  };
}

const LIST_CAP = 100;

/**
 * Posted lines in the period carrying a VAT code against an account on which
 * no supply can arise.
 *
 * Company-scoped on both `gl_journal_lines` and `gl_journal_entries`, matching
 * every other query in this report.
 */
export async function findVatNonSupplyLines(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT jl.journal_entry_id, je.entry_number, je.entry_date,
      ga.account_code, ga.account_name,
      jl.vat_type,
      COALESCE(je.description, jl.description, '') AS description,
      jl.debit - jl.credit AS amount,
      COUNT(*) OVER() AS total_count
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${periodStart}::DATE
      AND je.entry_date <= ${periodEnd}::DATE
      AND jl.vat_type IS NOT NULL
      AND jl.vat_type <> ALL(${NON_CLAIMING_VAT_TYPES as string[]}::TEXT[])
      AND ga.account_name ~* ${NON_SUPPLY_PATTERN}
    ORDER BY je.entry_date, je.entry_number
    LIMIT ${LIST_CAP}
  ` as Promise<DbRow[]>;
}
