/**
 * The one query behind the journal-derived VAT201 boxes.
 *
 * It returns EVERY posted line of every VAT-bearing journal in the period —
 * not only the lines on VAT accounts — because the base of a supply is the
 * journal's other legs and you cannot compute it from the VAT leg alone. See
 * `vatBoxBasis.ts` for what each leg means and why the base is not derived
 * from the tax.
 *
 * A journal is VAT-bearing when it has a leg on a VAT control account
 * (`vat_input`/`vat_output` — NOT the generic `tax` subtype, which Brightsphere
 * uses for Pay As You Earn), OR a leg carrying a VAT code against an account
 * with no VAT posting treatment. The second arm is not defensive: Velocity Fibre posts input tax to
 * SYS-9 "VAT Payable", a liability with a NULL subtype — 356 posted lines,
 * R4,917,814.24 — and a subtype-only filter drops the whole journal from the
 * return with no signal. Selecting it here is what lets the report say the
 * money is there and that it cannot place it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  BALANCE_SHEET_TYPES,
  VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES,
} from './vatBalanceSheetExceptions';
import { VAT_TAX_SUBTYPES, type VatLineInput } from './vatBoxBasis';

const NON_VAT_TYPES: readonly string[] = ['no_vat'];

/**
 * A document in one of these states raises no VAT, but its journal may still be
 * posted — Brightsphere has exactly that, R3,750 of output VAT on a cancelled
 * customer invoice. Both spellings are in use across the AR, AP and credit-note
 * tables.
 */
const CANCELLED_STATUSES: readonly string[] = ['cancelled', 'void', 'voided'];

export interface VatPeriodLines {
  lines: VatLineInput[];
  /**
   * MAX(created_at) across the journal rows consumed, as ISO-8601. Never
   * `now()`: this is what makes the figure re-derivable, so the same period
   * re-run tomorrow either matches or somebody back-dated a journal.
   */
  postedThrough: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dateOnly(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? '');
}

export async function getVatPeriodLines(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<VatPeriodLines> {
  const rows = (await sql`
    WITH RECURSIVE vat_entries AS (
      SELECT DISTINCT jl.journal_entry_id AS id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND je.entry_date >= ${periodStart}::DATE
        AND je.entry_date <= ${periodEnd}::DATE
        AND (
          COALESCE(ga.account_subtype, '') = ANY(${VAT_TAX_SUBTYPES as unknown as string[]}::TEXT[])
          OR (
            jl.vat_type IS NOT NULL
            AND jl.vat_type <> ALL(${NON_VAT_TYPES as string[]}::TEXT[])
            AND (
              -- A VAT code on a balance-sheet account with no VAT treatment.
              (
                ga.account_type = ANY(${BALANCE_SHEET_TYPES as string[]}::TEXT[])
                AND COALESCE(ga.account_subtype, '') <> ALL(
                  ${VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES as string[]}::TEXT[]
                )
              )
              -- Or on the GENERIC tax subtype, which is PAYE as often as VAT.
              OR COALESCE(ga.account_subtype, '') = 'tax'
            )
          )
        )
    )
    , cancelled_entries_base AS (
      SELECT ci.gl_journal_entry_id AS id FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID AND ci.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND ci.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT si.gl_journal_entry_id FROM supplier_invoices si
        WHERE si.company_id = ${companyId}::UUID AND si.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND si.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT cn.gl_journal_entry_id FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID AND cn.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND cn.gl_journal_entry_id IS NOT NULL
    )
    -- A cancellation posts a reversing journal that no document row links to,
    -- so the original alone was suppressed and the reversal landed in the boxes.
    -- The pair is only ever hidden TOGETHER. resolveReversalDate pushes the
    -- reversal into a later period when the original's period is closed, and
    -- then both legs are real: the original was filed in its own period and the
    -- credit belongs in the later one. So an original whose posted reversal
    -- falls outside this period is not suppressed either, while a cancelled
    -- document that was never reversed still is.
    -- Recursive because reversing the reversal by hand would otherwise re-admit
    -- the cancelled document's VAT; UNION dedupes, so a cycle terminates. Both
    -- arms walk POSTED journals only: a draft reversal has no GL effect, so it
    -- neither frees its original nor carries suppression on to its own reversal.
    , cancelled_entries AS (
      SELECT b.id FROM cancelled_entries_base b
        WHERE NOT EXISTS (
          SELECT 1 FROM gl_journal_entries out_rev
            WHERE out_rev.company_id = ${companyId}::UUID
              AND out_rev.reversal_of_id = b.id
              AND out_rev.status = 'posted'
              AND (out_rev.entry_date < ${periodStart}::DATE
                   OR out_rev.entry_date > ${periodEnd}::DATE)
        )
      UNION
      SELECT rev.id FROM gl_journal_entries rev
        JOIN gl_journal_entries parent ON parent.id = rev.reversal_of_id
        JOIN cancelled_entries ce ON ce.id = parent.id
        WHERE rev.company_id = ${companyId}::UUID
          AND rev.status = 'posted'
          AND parent.company_id = ${companyId}::UUID
          AND parent.entry_date >= ${periodStart}::DATE
          AND parent.entry_date <= ${periodEnd}::DATE
    )
    SELECT
      jl.id::TEXT              AS line_id,
      je.id::TEXT              AS journal_entry_id,
      COALESCE(je.entry_number, '') AS entry_number,
      je.entry_date::TEXT      AS entry_date,
      jl.gl_account_id::TEXT   AS account_id,
      ga.account_code,
      ga.account_name,
      ga.account_type,
      ga.account_subtype,
      jl.vat_type,
      jl.debit,
      jl.credit,
      GREATEST(je.created_at, jl.created_at) AS row_created_at,
      (je.id IN (SELECT id FROM cancelled_entries)) AS cancelled_source
    FROM gl_journal_lines jl
    JOIN vat_entries ve ON ve.id = jl.journal_entry_id
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
    ORDER BY je.entry_date, je.entry_number, ga.account_code, jl.id
  `) as DbRow[];

  let postedThrough = '';
  const lines: VatLineInput[] = rows.map((r) => {
    const created = iso(r.row_created_at);
    if (created > postedThrough) postedThrough = created;
    return {
      journalEntryId: String(r.journal_entry_id),
      entryNumber: String(r.entry_number ?? ''),
      entryDate: dateOnly(r.entry_date),
      lineId: String(r.line_id),
      accountId: String(r.account_id),
      accountCode: String(r.account_code ?? ''),
      accountName: String(r.account_name ?? ''),
      accountType: String(r.account_type ?? ''),
      accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
      vatType: r.vat_type == null ? null : String(r.vat_type),
      debit: num(r.debit),
      credit: num(r.credit),
      cancelledSource: r.cancelled_source === true,
    };
  });

  return { lines, postedThrough };
}
