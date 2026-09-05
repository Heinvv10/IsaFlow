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
 * by the same amount.
 *
 * WHICH report that money reaches matters, because there are two. The VAT legs
 * sit on a `vat_input` account coded `standard`, so `getVATReturn` puts them in
 * box 15 — and `getVATReturn` is not a display-only number: `vatSubmissionService`
 * (line 234) reads its `totalInputTax` and posts the period's real GL settlement
 * journal from it, crediting VAT Input and booking the net to accrued expenses.
 * So the fictitious R400 388,14 would be closed off as though it were claimable
 * and carried into a real posted journal. The ISV eFiling payload is a
 * different path — `submitVAT201ToSars` builds it from `generateVAT201`, which
 * is invoice-derived — so this money does NOT reach the filed VAT201's boxes.
 * Do not simplify either half of that sentence away.
 *
 * Brightsphere `35948127 Investment - Blitz Fibre` is the same mistake on the
 * output side: R9 782,61 of output tax on a R75 000 receipt credited to a share
 * investment, an exempt financial service.
 *
 * Nothing in the codebase would have reported either. `vat_input_denied`
 * exists but encodes s17(2)(a) entertainment DENIAL, which is a different fact
 * — there a supply happens and the claim is refused; here no supply happens at
 * all. inputVatDenial.ts already warns against conflating the two.
 *
 * IT BLOCKS NO POSTING — BUT IT IS NOT COSMETIC. Same altitude as the
 * balance-sheet rule: it reports before filing and refuses nothing anyone
 * posts. It does count toward `totalExceptions`, and `evaluateEfilingGate`
 * (sarsEfilingSubmissionService.ts:70) throws `EfilingBlockedError` on any
 * non-zero count, so a period containing one of these will refuse to file on
 * the ISV channel until the journal is corrected. That is the intended
 * behaviour of that gate — a period carrying fictitious input tax should not
 * be filed — and it is why this category is counted like the other eight
 * rather than shown as an advisory. The consequences, stated plainly:
 *   - There is no waive or acknowledge path anywhere in the gate, and a
 *     reversing journal does not clear one of these — the reversal carries the
 *     same `vat_type` on the same account, so it ADDS a row. Clearing means
 *     re-coding the original lines.
 *   - It newly blocks NOTHING in production, and that was measured, not
 *     assumed. Across all 13 tenants there are 7 (company, bi-monthly period)
 *     pairs where this rule fires, and every one of them already carries a
 *     non-zero count from query 1 or query 8 — Velocity 2025-P04 and 2025-P05,
 *     which have no uncoded lines, are already blocked by 92 and 74
 *     balance-sheet rows. An earlier draft of this note claimed those two
 *     periods were newly blocked; it had counted query 1 only.
 *   - And nothing is reachable today anyway: the ISV channel is unarmed in
 *     production (no `SARS_EFILING_*` env), so `submitVAT201ToSars` throws
 *     `EfilingNotConfiguredError` before the gate is reached.
 * If that trade is ever judged wrong, change the GATE, not this rule — making
 * one category advisory while eight block is the inconsistency that hides.
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
 * WHAT A NAME-MATCHED RULE CANNOT DO
 * -----------------------------------
 * A clean section here means "no name-matched non-supply VAT", not "no
 * non-supply VAT". Known gaps, none of which carry a VAT-coded line in
 * production today: `Bonus`, `Commission`, `Directors Remuneration`, `Medical
 * Aid`, `Pension`/`Provident Fund`, `13th Cheque`, `COIDA`/`WCA` on the
 * employment side; `Deferred Tax` and `Company Tax`; `Members Distribution`;
 * `Bond`, `Mortgage`, `Finance Charges`, `Debenture`, `Fixed Deposit`; and
 * `Impairment`. Add patterns as real account names appear — but re-run the
 * production sweep first, because the patterns cut the other way too.
 *
 * The rule also produces CANDIDATES, not verdicts, and a handful of real
 * account names are genuinely ambiguous: casual or contract labour supplied
 * through a labour broker IS a taxable supply with claimable input tax
 * (production has `COS - Casual wages - EX2009`, no VAT-coded lines today);
 * so are "Payroll Software", "Investment Property" rental, and engineering
 * "Technical Drawings". Name alone cannot separate those from the dominant
 * case, so the section reads as "check these before you file" rather than as
 * an assertion of error.
 *
 * Verified against production before shipping, across all 13 companies: the
 * patterns match 192 `gl_accounts` rows (176 active, 86 distinct names), of
 * which 44 carry any journal line at all. Of the posted VAT-coded lines on
 * those, exactly the two defects above are flagged and nothing else. Every
 * other standard-rated account in the ledger — bank charges, short-term
 * insurance, travel, entertainment — is deliberately absent from the patterns
 * because those ARE supplies.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { dateStr, r2, toNum } from './vatExceptionsTypes';
import type { NonSupplyReason, VatNonSupplyLine } from './vatExceptionsTypes';

/**
 * VAT codes that make no claim, so carry no defect on a non-supply account.
 *
 * `exempt` is here and is load-bearing — but for ONE of the six categories.
 * Interest received and share/loan transactions are genuinely s12(a) exempt
 * supplies, and coding `financial_service` accounts `exempt` is the correct
 * treatment; without this exclusion the rule would flag every properly-coded
 * interest account in the platform (production has 2 such lines today, on
 * `4310 Interest Received`).
 *
 * For the other five categories `exempt` is NOT correct — salaries, taxes,
 * distributions and depreciation are OUT OF SCOPE, not exempt, and `no_vat`
 * is the right code. `exempt` on those positively asserts that a supply
 * occurred and was exempt, which in `getVATReturn` lands in output box 3 and
 * so distorts the s17(1) turnover apportionment ratio. The exclusion stays
 * whole anyway: `getVATReturn` only reads accounts subtyped `vat_input`,
 * `vat_output` or `tax`, so an `exempt` code on a salary EXPENSE account
 * reaches no box today, and production carries no such line. If that changes,
 * the fix is a narrower exclusion — `exempt` accepted only for
 * `financial_service` — not the removal of this constant.
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
  { reason: 'financial_service', pattern: 'interest|investment|\\mloans?\\M' },
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
  const reason = classifyNonSupplyAccount(accountName);
  if (reason === null) {
    // The SQL filtered on the union of the same patterns, so this row matched
    // in Postgres and not in JavaScript. That is drift between the two
    // engines, and the UI would render it as a blank "Why" — invisible.
    // Say it out loud instead.
    log.warn(
      'Non-supply line matched in SQL but not by the classifier — pattern drift',
      { accountName },
      'vatNonSupplyExceptions',
    );
  }
  const rawJournalVat = r.journal_vat;
  return {
    journalEntryId: String(r.journal_entry_id),
    entryNumber: String(r.entry_number ?? ''),
    entryDate: dateStr(r.entry_date),
    accountCode: String(r.account_code ?? ''),
    accountName,
    // Classified here rather than in SQL so the ordered pattern list stays the
    // single source of truth. Null should be unreachable while the SQL filters
    // on the union of the same patterns — verified across all 387 distinct
    // production account names, both engines select the same 86 — and it is
    // typed anyway rather than defaulted to a category, so a future divergence
    // shows as a blank reason and a logged warning rather than a confidently
    // wrong one.
    reason,
    vatType: String(r.vat_type ?? ''),
    description: String(r.description ?? ''),
    amount: r2(toNum(r.amount)),
    journalVat: rawJournalVat === null || rawJournalVat === undefined
      ? null
      : r2(toNum(rawJournalVat)),
  };
}

const LIST_CAP = 100;

/**
 * Posted lines in the period carrying a VAT code against an account on which
 * no supply can arise.
 *
 * Company-scoped on `gl_journal_lines`, `gl_journal_entries` AND the account
 * join, so tenant isolation is local to this query rather than inherited from
 * an assumed invariant elsewhere.
 *
 * `journal_vat` is the VAT-control movement of the WHOLE journal entry, not of
 * this line — the flagged line is the contra leg and carries the expense, not
 * the tax. Without it the report shows R2 669 254,37 of salary and never the
 * R400 388,14 of input tax it exists to surface. Journal-level is the honest
 * granularity: the tax leg is not attributable to one contra line when a
 * journal has several, so it repeats per row rather than pretending to split.
 * (In production all 30 flagged journals carry exactly one flagged line, so
 * the repeat has no instance today.)
 *
 * It is NULL, not 0, when the journal has no VAT leg this query can identify —
 * and there is a real way for that to happen. The subquery finds the tax leg
 * by `account_subtype IN ('vat_input','vat_output')`, and production contains
 * a VAT control account with a NULL subtype: Velocity `SYS-9 VAT Payable`,
 * 356 VAT-coded lines, R4 917 814,24. A journal settling through SYS-9 would
 * sum to nothing here. Rendering that as R0,00 on the column that carries the
 * whole point of the rule would be indistinguishable from "this journal has no
 * VAT" — on a money figure feeding a filing gate. So the SUM is deliberately
 * NOT wrapped in COALESCE: zero rows yields NULL and the UI shows an em dash,
 * while VAT legs that genuinely net to zero still sum to 0 and display as
 * R0,00. Unknown and zero must not look the same.
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
      (
        SELECT SUM(
          CASE WHEN vga.account_subtype = 'vat_output'
            THEN vjl.credit - vjl.debit ELSE vjl.debit - vjl.credit END
        )
        FROM gl_journal_lines vjl
        JOIN gl_accounts vga
          ON vga.id = vjl.gl_account_id AND vga.company_id = vjl.company_id
        WHERE vjl.journal_entry_id = jl.journal_entry_id
          AND vjl.company_id = jl.company_id
          AND vga.account_subtype IN ('vat_input', 'vat_output')
      ) AS journal_vat,
      COUNT(*) OVER() AS total_count
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
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
