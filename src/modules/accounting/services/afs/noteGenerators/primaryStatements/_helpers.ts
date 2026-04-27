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
import { fmt, toNum, fiscalRange } from '../noteHelpers';

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
}

export async function fetchSectionLines(
  companyId: string,
  section: 'balance_sheet' | 'income_statement',
  fiscalYear: number,
  priorYear?: number,
): Promise<SectionLine[]> {
  const { start, end } = fiscalRange(fiscalYear);
  const priorStart = priorYear ? `${priorYear}-01-01` : null;
  const priorEnd = priorYear ? `${priorYear}-12-31` : null;
  const isBs = section === 'balance_sheet';

  const rows = (await sql`
    SELECT
      sl.code, sl.label, sl.parent_code, sl.note_number, sl.sort_order,
      sl.is_header, sl.is_total,
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
    GROUP BY sl.code, sl.label, sl.parent_code, sl.note_number, sl.sort_order, sl.is_header, sl.is_total
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
  }));
}

export function rollUpTotals(lines: SectionLine[]): SectionLine[] {
  // For each is_total line, sum its siblings (lines with the same
  // parent_code that are neither headers nor totals) into whichever year
  // is currently 0. Skips a year only if it ALREADY has a value, so a
  // legitimate prior-year 0 alongside a non-zero current still rolls up
  // for the current side without clobbering the prior.
  const byParent = new Map<string, SectionLine[]>();
  for (const l of lines) {
    if (l.parentCode && !l.isHeader && !l.isTotal) {
      const arr = byParent.get(l.parentCode) ?? [];
      arr.push(l);
      byParent.set(l.parentCode, arr);
    }
  }
  return lines.map((l) => {
    if (!l.isTotal) return l;
    const siblings = byParent.get(l.parentCode ?? '') ?? [];
    if (siblings.length === 0) return l;
    return {
      ...l,
      currentAmount: l.currentAmount === 0 ? siblings.reduce((s, x) => s + x.currentAmount, 0) : l.currentAmount,
      priorAmount: l.priorAmount === 0 ? siblings.reduce((s, x) => s + x.priorAmount, 0) : l.priorAmount,
    };
  });
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
