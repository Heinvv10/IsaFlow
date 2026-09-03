// Shared helpers for AFS primary statement generators.
//
// fetchSectionLines pulls every active line in a statement section from
// afs_statement_lines, joins to afs_account_mappings + posted GL, and
// returns one row per line with current/prior amounts. BS lines are
// cumulative (entry_date <= end); IS lines are period flow.
//
// rollUpTotals best-effort sums children to parents for is_total rows
// whose existing amount is 0 (does NOT overwrite accountant-edited
// totals). Uses || not && — a row legitimately 0 in current year but
// non-zero in prior is preserved.
//
// renderHierarchicalTable emits NoteContent.blocks with leaf-filtering
// and bold totals.

import { sql } from '@/lib/neon';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum } from '../noteHelpers';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

type DbRow = Record<string, unknown>;

export interface SectionLine {
  code: string;
  label: string;
  parentCode: string | null;
  noteNumber: number | null;
  sortOrder: number;
  isHeader: boolean;
  isTotal: boolean;
  currentAmount: number;
  priorAmount: number;
  /** How this line's figure is computed. Only consulted when `isTotal`. */
  totalBasis: TotalBasis;
  /** Codes summed when `totalBasis` is 'components'. */
  totalComponents: string[] | null;
}

/**
 * How a total gets its number.
 *
 *   children    sum the non-total children sharing this line's parent_code.
 *   components  sum the codes named in `totalComponents`.
 *   running     the preceding total, plus every non-total line between it and
 *               this one — the income statement's accumulating bottom lines.
 */
export type TotalBasis = 'children' | 'components' | 'running';

export async function fetchSectionLines(
  companyId: string,
  section: 'balance_sheet' | 'income_statement',
  fiscalYear: number,
  priorYear?: number,
): Promise<SectionLine[]> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);
  // The comparative year is on the SAME fiscal calendar as the current one.
  // Hard-coding January-December here reintroduced the very defect the current
  // year was fixed for, silently and only in the prior-year column.
  const prior = priorYear ? await getFiscalRange(companyId, priorYear) : null;
  const priorStart = prior?.start ?? null;
  const priorEnd = prior?.end ?? null;
  const isBs = section === 'balance_sheet';

  const rows = (await sql`
    SELECT
      sl.code, sl.label, sl.parent_code, sl.note_number, sl.sort_order,
      sl.is_header, sl.is_total, sl.total_basis, sl.total_components,
      COALESCE(SUM(
        CASE
          WHEN am.gl_account_id IS NULL THEN 0
          WHEN ${isBs}::boolean
            THEN CASE WHEN gje.entry_date <= ${end}::date THEN (gjl.debit - gjl.credit) ELSE 0 END
          ELSE CASE WHEN gje.entry_date BETWEEN ${start}::date AND ${end}::date THEN (gjl.debit - gjl.credit) ELSE 0 END
        END
      ), 0) AS current_amount,
      COALESCE(SUM(
        CASE
          WHEN am.gl_account_id IS NULL OR ${priorEnd}::date IS NULL THEN 0
          WHEN ${isBs}::boolean
            THEN CASE WHEN gje.entry_date <= ${priorEnd}::date THEN (gjl.debit - gjl.credit) ELSE 0 END
          ELSE CASE WHEN gje.entry_date BETWEEN ${priorStart}::date AND ${priorEnd}::date THEN (gjl.debit - gjl.credit) ELSE 0 END
        END
      ), 0) AS prior_amount
    FROM afs_statement_lines sl
    LEFT JOIN afs_account_mappings am ON am.afs_line_code = sl.code AND am.company_id = sl.company_id
    LEFT JOIN gl_journal_lines gjl ON gjl.gl_account_id = am.gl_account_id AND gjl.company_id = ${companyId}::uuid
    LEFT JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id AND gje.status = 'posted' AND gje.company_id = ${companyId}::uuid
    WHERE sl.company_id = ${companyId}::uuid
      AND sl.section = ${section}
      AND sl.is_active = true
    GROUP BY sl.code, sl.label, sl.parent_code, sl.note_number, sl.sort_order, sl.is_header, sl.is_total, sl.total_basis, sl.total_components
    ORDER BY sl.sort_order
  `) as DbRow[];

  return rows.map((r) => ({
    code: String(r.code),
    label: String(r.label),
    parentCode: r.parent_code != null ? String(r.parent_code) : null,
    noteNumber: r.note_number != null ? Number(r.note_number) : null,
    sortOrder: Number(r.sort_order ?? 0),
    isHeader: Boolean(r.is_header),
    isTotal: Boolean(r.is_total),
    currentAmount: toNum(r.current_amount),
    priorAmount: toNum(r.prior_amount),
    totalBasis: (r.total_basis as TotalBasis | null) ?? 'children',
    totalComponents: Array.isArray(r.total_components) ? (r.total_components as string[]) : null,
  }));
}

/**
 * Give every `is_total` line its figure.
 *
 * A total is only computed when it is currently 0, so a figure that came from
 * the ledger (or an accountant's override) is never clobbered. The two years
 * are decided independently: a line legitimately 0 this year but non-zero last
 * still rolls up on the side that needs it.
 *
 * Lines are processed in sort order, because a 'running' total reads the total
 * before it and a 'components' total reads subtotals declared earlier.
 *
 * THE DEFECT THIS CLOSES: the previous implementation only ever summed
 * "siblings sharing my parent_code". The six most important lines in the
 * taxonomy — Total assets, Total equity and liabilities, and the four income
 * statement bottom lines — are top-level with no parent_code, so it found no
 * siblings and left all six at 0.00 on every company.
 */
export function rollUpTotals(lines: SectionLine[]): SectionLine[] {
  const ordered = [...lines].sort((a, b) => a.sortOrder - b.sortOrder);

  const byParent = new Map<string, SectionLine[]>();
  for (const l of ordered) {
    if (l.parentCode && !l.isHeader && !l.isTotal) {
      const arr = byParent.get(l.parentCode) ?? [];
      arr.push(l);
      byParent.set(l.parentCode, arr);
    }
  }

  const resolved = new Map<string, SectionLine>();
  // Non-total lines seen since the last total — the basis for a running total.
  let sinceLastTotal: SectionLine[] = [];
  let previousTotal: SectionLine | null = null;

  for (const l of ordered) {
    if (!l.isTotal) {
      if (!l.isHeader) sinceLastTotal.push(l);
      resolved.set(l.code, l);
      continue;
    }

    let contributors: SectionLine[];
    let baseCurrent = 0;
    let basePrior = 0;

    switch (l.totalBasis) {
      case 'components':
        // Only codes already resolved count, so a component listed out of
        // order contributes nothing rather than a stale zero.
        contributors = (l.totalComponents ?? [])
          .map((code) => resolved.get(code))
          .filter((x): x is SectionLine => x !== undefined);
        break;

      case 'running':
        contributors = sinceLastTotal;
        baseCurrent = previousTotal?.currentAmount ?? 0;
        basePrior = previousTotal?.priorAmount ?? 0;
        break;

      default:
        contributors = byParent.get(l.parentCode ?? '') ?? [];
        break;
    }

    const summedCurrent = baseCurrent + contributors.reduce((s, x) => s + x.currentAmount, 0);
    const summedPrior = basePrior + contributors.reduce((s, x) => s + x.priorAmount, 0);

    const computed: SectionLine = {
      ...l,
      currentAmount: l.currentAmount === 0 ? summedCurrent : l.currentAmount,
      priorAmount: l.priorAmount === 0 ? summedPrior : l.priorAmount,
    };

    resolved.set(l.code, computed);
    previousTotal = computed;
    // Each line belongs to exactly one running total.
    sinceLastTotal = [];
  }

  // Preserve the caller's original ordering.
  return lines.map((l) => resolved.get(l.code) ?? l);
}

export function renderHierarchicalTable(
  lines: SectionLine[],
  hasPriorYear: boolean,
): NoteContent['blocks'] {
  const visible = lines.filter((l) => l.isHeader || l.isTotal || l.currentAmount !== 0 || l.priorAmount !== 0);
  const headers = hasPriorYear ? ['Line', 'Current year (R)', 'Prior year (R)'] : ['Line', 'Current year (R)'];
  const rows: string[][] = [];
  for (const l of visible) {
    const indent = l.parentCode ? '  ' : '';
    if (l.isHeader) {
      rows.push([`**${l.label}**`, '', ...(hasPriorYear ? [''] : [])]);
      continue;
    }
    const labelPrefix = l.isTotal ? `${indent}**${l.label}**` : `${indent}${l.label}`;
    if (hasPriorYear) {
      rows.push([labelPrefix, fmt(l.currentAmount), fmt(l.priorAmount)]);
    } else {
      rows.push([labelPrefix, fmt(l.currentAmount)]);
    }
  }
  return [{ type: 'table', headers, rows }];
}

// Sign-flip helper: flips current+prior on a line, preserving everything else.
export function flipSign(l: SectionLine): SectionLine {
  return { ...l, currentAmount: -l.currentAmount, priorAmount: -l.priorAmount };
}
