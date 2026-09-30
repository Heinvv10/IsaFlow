/**
 * Paging support for `getAccountLedger`: year-end close rows (see
 * gl/fiscalYearCloseRows.ts) and the balance a page opens at.
 *
 * The ledger pages by LIMIT/OFFSET over journal lines, so derived close rows
 * are placed by POSITION: a close for boundary B sits after every in-range line
 * dated before B, i.e. at `linesBefore(B) + (closes before it)`. A page's slice
 * of lines is then offset by the closes that precede it.
 *
 * Every query is scoped on BOTH jl.company_id and je.company_id.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { RunningBalance, toMoney } from '@/lib/money/decimalSum';
import {
  closeRowAmounts,
  fiscalYearEndBefore,
  yearEndCloseDescription,
} from '../gl/fiscalYearCloseRows';
import type { AccountLedgerRow } from './accountLedgerTypes';

export interface LedgerScope {
  companyId: string;
  accountId: string;
  cc: string | null;
  bu: string | null;
  postedOnly: boolean;
  fromDate: string;
  toDate: string;
  normalBalance: string;
}

export interface YearEndClose {
  boundary: string;
  /** Normal-side balance immediately before the boundary — what the close reverses. */
  balanceBefore: number;
  /** Position of the close row in the combined (lines + closes) sequence. */
  position: number;
}

function signed(scope: LedgerScope, debit: number, credit: number): number {
  return scope.normalBalance === 'debit' ? debit - credit : credit - debit;
}

/**
 * One close per boundary with a non-zero balance. The balance before boundary k is the movement in
 * [boundary k-1, boundary k), with boundary 0 = the opening floor — so the
 * first close includes the pre-fromDate year-to-date carried in the opening.
 */
export async function loadYearEndCloses(
  scope: LedgerScope,
  openingFloor: string,
  boundaries: readonly string[],
): Promise<YearEndClose[]> {
  const { companyId, accountId, cc, bu, postedOnly, fromDate } = scope;
  const closes: YearEndClose[] = [];
  let prev = openingFloor;
  for (const boundary of boundaries) {
    const rows = (await sql`
      SELECT
        COALESCE(SUM(jl.debit)  FILTER (WHERE je.entry_date >= ${prev}::date), 0) AS d,
        COALESCE(SUM(jl.credit) FILTER (WHERE je.entry_date >= ${prev}::date), 0) AS c,
        COUNT(*) FILTER (WHERE je.entry_date >= ${fromDate}::date) AS n
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.company_id    = ${companyId}::UUID
        AND je.company_id    = ${companyId}::UUID
        AND jl.gl_account_id = ${accountId}::UUID
        AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
          OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
        AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
        AND (${postedOnly}::boolean = false OR je.status = 'posted')
        AND je.entry_date >= LEAST(${prev}::date, ${fromDate}::date)
        AND je.entry_date <  ${boundary}::date
    `) as DbRow[];
    const r = rows[0];
    const balanceBefore = toMoney(signed(scope, Number(r?.d ?? 0), Number(r?.c ?? 0)));
    // A zero balance has nothing to close; no row, as in runWithYearEndCloses.
    if (balanceBefore !== 0) {
      closes.push({ boundary, balanceBefore, position: Number(r?.n ?? 0) + closes.length });
    }
    prev = boundary;
  }
  return closes;
}

export interface PagePlan {
  lineOffset: number;
  lineLimit: number;
  closesBefore: YearEndClose[];
}

/** Which journal lines a combined page [offset, offset+limit) needs. */
export function planPage(closes: readonly YearEndClose[], offset: number, limit: number): PagePlan {
  const closesBefore = closes.filter(c => c.position < offset);
  const inWindow = closes.filter(c => c.position >= offset && c.position < offset + limit).length;
  return { lineOffset: offset - closesBefore.length, lineLimit: limit - inWindow, closesBefore };
}

/** Normal-side net of the first `n` in-range lines, in page order. */
export async function netOfFirstLines(scope: LedgerScope, n: number): Promise<number> {
  if (n <= 0) return 0;
  const { companyId, accountId, cc, bu, postedOnly, fromDate, toDate } = scope;
  const rows = (await sql`
    SELECT COALESCE(SUM(t.debit), 0) AS d, COALESCE(SUM(t.credit), 0) AS c
    FROM (
      SELECT jl.debit, jl.credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.company_id    = ${companyId}::UUID
        AND je.company_id    = ${companyId}::UUID
        AND jl.gl_account_id = ${accountId}::UUID
        AND (${cc}::uuid IS NULL OR jl.cost_center_id = ${cc}::uuid
          OR jl.cc1_id = ${cc}::uuid OR jl.cc2_id = ${cc}::uuid)
        AND (${bu}::uuid IS NULL OR jl.bu_id = ${bu}::uuid)
        AND (${postedOnly}::boolean = false OR je.status = 'posted')
        AND je.entry_date >= ${fromDate}
        AND je.entry_date <= ${toDate}
      ORDER BY je.entry_date ASC, je.id ASC
      LIMIT ${n}
    ) t
  `) as DbRow[];
  return signed(scope, Number(rows[0]?.d ?? 0), Number(rows[0]?.c ?? 0));
}

/** Interleave the page's close rows with its journal lines and run the balance from `pageOpening`. */
export function buildPageRows(
  txnRows: readonly DbRow[],
  closes: readonly YearEndClose[],
  plan: { offset: number; limit: number },
  pageOpening: number,
  normalBalance: string,
): AccountLedgerRow[] {
  const running = new RunningBalance(pageOpening);
  const out: AccountLedgerRow[] = [];
  let next = 0;
  for (let pos = plan.offset; pos < plan.offset + plan.limit; pos += 1) {
    const close = closes.find(c => c.position === pos);
    if (close) {
      const { debit, credit } = closeRowAmounts(close.balanceBefore, normalBalance);
      const fyEnd = fiscalYearEndBefore(close.boundary);
      out.push({
        journalEntryId: '', entryDate: fyEnd, entryNumber: '', description: yearEndCloseDescription(fyEnd),
        reference: '', source: 'year_end_close', debit, credit,
        runningBalance: running.subtract(close.balanceBefore), derived: true,
      });
      continue;
    }
    const r = txnRows[next];
    if (!r) break;
    next += 1;
    const d = toMoney(Number(r.debit ?? 0));
    const c = toMoney(Number(r.credit ?? 0));
    running.add(normalBalance === 'debit' ? d : c);
    out.push({
      journalEntryId: String(r.journal_entry_id),
      entryDate: fmtDate(r.entry_date),
      entryNumber: String(r.entry_number ?? ''),
      description: String(r.description ?? ''),
      reference: String(r.reference ?? ''),
      source: String(r.source ?? 'manual'),
      debit: d,
      credit: c,
      runningBalance: running.subtract(normalBalance === 'debit' ? c : d),
    });
  }
  return out;
}
