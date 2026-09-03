/**
 * Read back what `set_opening_balance` wrote — both halves of it.
 *
 * `set_opening_balance` posts a journal (`source = 'auto_migration'`) AND writes
 * `gl_accounts.bank_opening_balance`, deliberately, because the column is
 * DISPLAY metadata that `getBankAccountsStatus` never adds to a balance.
 * Writing it alone shows the right number on the screen a person checks while
 * the trial balance, the balance sheet and every reconciliation stay wrong.
 *
 * The bank-account editor can still write that column with no journal behind
 * it, so the two CAN disagree — and until now nothing read either of them back,
 * which meant no GL-versus-bank comparison was possible on any account. The
 * disagreement is the finding, so it is a field (`agrees`) and a list
 * (`disagreements`), never resolved into a single number that agrees with
 * itself.
 *
 * `is_active` is not a filter here for the usual reason: a deactivated account
 * with an opening balance is still on the balance sheet, and Brightsphere's
 * deactivated 1110 carries R6,550 today.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/** Cent tolerance. Below this the two figures describe the same money. */
const AGREEMENT_TOLERANCE = 0.01;

export interface OpeningBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountSubtype: string | null;
  isActive: boolean;
  /** Net of the posted opening-balance journals, or null when none exist. */
  postedAmount: number | null;
  /** Date of the latest opening-balance journal. */
  postedAsAt: string | null;
  /** `gl_accounts.bank_opening_balance` — display metadata only. */
  metadataAmount: number | null;
  metadataAsAt: string | null;
  /** The two agree, or neither exists. False is the finding. */
  agrees: boolean;
  /** The journals behind `postedAmount`, so the figure has a drill-down. */
  journalEntryIds: string[];
  entryNumbers: string[];
}

export interface OpeningBalances {
  rows: OpeningBalanceRow[];
  /** Rows where the ledger and the banking screen say different things. */
  disagreements: OpeningBalanceRow[];
  /** Account codes with neither a journal nor metadata. */
  accountsWithoutOpeningBalance: string[];
  totals: { posted: number; metadata: number };
  /** MAX(created_at) of the opening-balance journals, or null. */
  postedThrough: string | null;
}

function num(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isoTimestamp(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  return String(raw);
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v) => v !== null && v !== undefined).map(String) : [];
}

export async function getOpeningBalances(
  companyId: string,
  bankAccountId?: string,
): Promise<OpeningBalances> {
  // The journal side is restricted in the JOIN's ON clause and handled
  // explicitly in the aggregates, so an account with no opening-balance journal
  // still appears — that account is the interesting one.
  const rows = (await sql`
    SELECT ga.id,
           ga.account_code,
           ga.account_name,
           ga.account_subtype,
           ga.is_active,
           ga.bank_opening_balance      AS metadata_amount,
           ga.bank_opening_balance_date AS metadata_as_at,
           SUM(CASE WHEN je.id IS NULL THEN NULL ELSE jl.debit - jl.credit END)::numeric AS posted_amount,
           MAX(je.entry_date)                                                            AS posted_as_at,
           MAX(je.created_at)                                                            AS posted_through,
           COALESCE(array_agg(DISTINCT je.id::text) FILTER (WHERE je.id IS NOT NULL), '{}')            AS journal_entry_ids,
           COALESCE(array_agg(DISTINCT je.entry_number) FILTER (WHERE je.id IS NOT NULL), '{}')        AS entry_numbers
      FROM gl_accounts ga
      LEFT JOIN gl_journal_lines jl
             ON jl.gl_account_id = ga.id
            AND jl.company_id    = ${companyId}::UUID
      LEFT JOIN gl_journal_entries je
             ON je.id         = jl.journal_entry_id
            AND je.company_id = ${companyId}::UUID
            AND je.status     = 'posted'
            AND je.source     = 'auto_migration'
     WHERE ga.company_id      = ${companyId}::UUID
       AND ga.account_subtype = 'bank'
       AND (${bankAccountId ?? null}::UUID IS NULL OR ga.id = ${bankAccountId ?? null}::UUID)
     GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_subtype, ga.is_active,
              ga.bank_opening_balance, ga.bank_opening_balance_date
     ORDER BY ga.account_code
  `) as DbRow[];

  const mapped: OpeningBalanceRow[] = rows.map((r) => {
    const postedAmount = num(r.posted_amount);
    const metadataAmount = num(r.metadata_amount);
    return {
      accountId: String(r.id),
      accountCode: String(r.account_code),
      accountName: String(r.account_name),
      accountSubtype: r.account_subtype === null || r.account_subtype === undefined
        ? null : String(r.account_subtype),
      isActive: r.is_active === true,
      postedAmount,
      postedAsAt: r.posted_as_at === null || r.posted_as_at === undefined
        ? null : fmtDate(r.posted_as_at),
      metadataAmount,
      metadataAsAt: r.metadata_as_at === null || r.metadata_as_at === undefined
        ? null : fmtDate(r.metadata_as_at),
      agrees: Math.abs((postedAmount ?? 0) - (metadataAmount ?? 0)) < AGREEMENT_TOLERANCE,
      journalEntryIds: strings(r.journal_entry_ids),
      entryNumbers: strings(r.entry_numbers),
    };
  });

  const stamps = rows
    .map((r) => isoTimestamp(r.posted_through))
    .filter((s): s is string => s !== null);

  return {
    rows: mapped,
    disagreements: mapped.filter((r) => !r.agrees),
    // Zero counts as "not set", not as "set to zero". The column DEFAULTS to
    // 0.00 rather than NULL — all 81 Velocity bank accounts read 0.00 today —
    // and `set_opening_balance` refuses a zero amount outright, so a stored
    // zero can only be the default. Treating it as a value would report every
    // account as having an opening balance and the list would always be empty.
    accountsWithoutOpeningBalance: mapped
      .filter((r) => !r.postedAmount && !r.metadataAmount)
      .map((r) => r.accountCode),
    totals: {
      posted: mapped.reduce((s, r) => s + (r.postedAmount ?? 0), 0),
      metadata: mapped.reduce((s, r) => s + (r.metadataAmount ?? 0), 0),
    },
    postedThrough: stamps.length === 0 ? null : stamps.reduce((a, b) => (a > b ? a : b)),
  };
}
