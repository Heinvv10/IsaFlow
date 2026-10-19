/**
 * Dimension-only tagging of POSTED journal lines — the PLAN half (reads and
 * every refusal). The apply half is dimensionTagApply.ts.
 *
 * What it may change: cc1_id, cc2_id, bu_id on an existing posted line. Never
 * an amount, account, date, description or VAT code — the request shape has no
 * field for any of them, and the apply UPDATE names only the three columns.
 *
 * What it refuses (brief §5.3 / §5.5):
 *   - a line that is not on a POSTED journal (a draft's dimensions are edited
 *     on the draft; a manual draft's approval digest hashes them);
 *   - a line on a control account (bank, AP, AR, VAT, payroll clearing) or on a
 *     settlement / receipt / transfer / VAT-payment journal;
 *   - a CC2 whose FNO conflicts with the CC1 named on the same line.
 *
 * A line in a CLOSED fiscal period may be tagged: amounts do not move, so the
 * AFS and VAT201 are untouched, but the batch is recorded as a restatement.
 */
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { NO_DIMENSION_SOURCES, checkCosProjects, isControlSubtype } from './dimensionPolicy';
import { resolveDimensionRefs } from './dimensionRefResolver';
import { deriveLineDimensions } from './dimensionDerivation';
import { DimensionRefusal, type DimensionIds, type DimensionRefs } from './dimensionTypes';
import type { GLEntrySource } from '../../../types/gl.types';
import { YEAR_END_JOURNAL_SOURCE } from '../yearEndJournalSource';

export const MAX_TAG_LINES = 500;

/** Per line: a string sets (code, UUID or alias), null clears, absent keeps. */
export interface TagLineInput {
  journalLineId: string;
  cc1?: string | null;
  cc2?: string | null;
  bu?: string | null;
  unallocatedReason?: string;
}

export interface TagLinePlan {
  journalLineId: string;
  entryNumber: string;
  accountCode: string;
  old: DimensionIds;
  next: DimensionIds;
  unallocatedReason: string | null;
  periodClosed: boolean;
}

export interface TagPlan {
  lines: TagLinePlan[];
  /** Lines whose dimensions already equal the request — not written. */
  unchanged: string[];
  isRestatement: boolean;
  warnings: string[];
}

interface LineRow {
  id: string; cc1: string | null; cc2: string | null; bu: string | null;
  account_code: string; account_subtype: string | null; status: string; source: string;
  entry_number: string | null; period_status: string | null; gl_account_id: string;
}

const same = (a?: string | null, b?: string | null): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/**
 * The lines are locked here, in id order (ORDER BY jl.id, whatever order the caller listed them in or the planner
 * scans them): every path that locks journal lines for tagging (this plan, the reversal's lockBatchJournalLines) takes
 * them lowest id first and then the bank rows lowest id first, so two of them cannot deadlock (40P01).
 */
export async function planDimensionTags(companyId: string, items: readonly TagLineInput[]): Promise<TagPlan> {
  if (items.length === 0 || items.length > MAX_TAG_LINES) {
    throw new DimensionRefusal(`lines must hold 1 to ${MAX_TAG_LINES} entries`);
  }
  const ids = items.map((it, i) => {
    if (!UUID_RE.test(it.journalLineId)) throw new DimensionRefusal(`lines[${i}].journal_line_id must be a UUID`);
    return it.journalLineId.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw new DimensionRefusal('a journal_line_id is listed twice');

  const rows = (await sql`
    SELECT jl.id::TEXT AS id, jl.cc1_id::TEXT AS cc1, jl.cc2_id::TEXT AS cc2, jl.bu_id::TEXT AS bu,
           jl.gl_account_id::TEXT AS gl_account_id, a.account_code, a.account_subtype,
           je.status, je.source, je.entry_number, fp.status AS period_status
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id AND fp.company_id = je.company_id
    WHERE jl.company_id = ${companyId}::UUID AND jl.id = ANY(${ids}::UUID[])
    ORDER BY jl.id
    FOR UPDATE OF jl
  `) as LineRow[];
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new DimensionRefusal(`${missing.length} journal_line_id(s) not found in this company`);

  items.forEach((it, i) => {
    const row = byId.get(ids[i]!)!;
    const where = `lines[${i}] (${row.entry_number ?? 'journal'} ${row.account_code})`;
    if (row.status !== 'posted') throw new DimensionRefusal(`${where}: only posted lines are tagged here; edit a draft on the draft`);
    if (isControlSubtype(row.account_subtype)) {
      throw new DimensionRefusal(`${where}: a control-account line (bank, AP, AR, VAT, payroll clearing) carries no dimensions`);
    }
    if (row.source === YEAR_END_JOURNAL_SOURCE) {
      throw new DimensionRefusal(`${where}: the year-end closing journal is the lock record of a closed year and carries no dimensions`);
    }
    if (NO_DIMENSION_SOURCES.has(row.source as GLEntrySource)) {
      throw new DimensionRefusal(`${where}: a settlement, receipt, transfer or VAT-payment journal carries no dimensions`);
    }
  });

  const refs: (DimensionRefs | undefined)[] = items.map((it) => ({
    ...(typeof it.cc1 === 'string' ? { cc1: it.cc1 } : {}),
    ...(typeof it.cc2 === 'string' ? { cc2: it.cc2 } : {}),
    ...(typeof it.bu === 'string' ? { bu: it.bu } : {}),
  }));
  const resolved = await resolveDimensionRefs(companyId, refs);
  const proposed = items.map((it, i) => {
    const row = byId.get(ids[i]!)!;
    const r = resolved[i] ?? {};
    const pick = (v: string | null | undefined, set: string | undefined, old: string | null): string | undefined =>
      v === null ? undefined : v === undefined ? (old ?? undefined) : set;
    return {
      // A new project re-derives the FNO unless the caller named one: the old CC1 may belong to the old project.
      cc1Id: it.cc1 === undefined && typeof it.cc2 === 'string' ? undefined : pick(it.cc1, r.cc1Id, row.cc1),
      cc2Id: pick(it.cc2, r.cc2Id, row.cc2),
      buId: pick(it.bu, r.buId, row.bu),
    } as DimensionIds;
  });
  const derived = await deriveLineDimensions(companyId, proposed, (i) => `lines[${i}]`);

  const lines: TagLinePlan[] = [];
  const unchanged: string[] = [];
  derived.forEach((next, i) => {
    const row = byId.get(ids[i]!)!;
    const old: DimensionIds = { cc1Id: row.cc1 ?? undefined, cc2Id: row.cc2 ?? undefined, buId: row.bu ?? undefined };
    const reason = items[i]!.unallocatedReason?.trim() || null;
    if (same(old.cc1Id, next.cc1Id) && same(old.cc2Id, next.cc2Id) && same(old.buId, next.buId) && !reason) {
      unchanged.push(row.id);
      return;
    }
    lines.push({
      journalLineId: row.id, entryNumber: String(row.entry_number ?? ''), accountCode: String(row.account_code),
      old, next, unallocatedReason: reason,
      periodClosed: row.period_status === 'closed' || row.period_status === 'locked',
    });
  });

  const cos = await checkCosProjects(companyId, derived.map((d, i) => ({
    glAccountId: byId.get(ids[i]!)!.gl_account_id, cc2Id: d.cc2Id,
  })));
  const warnings = cos.missing.length > 0
    ? [`${cos.missing.map((i) => `lines[${i}]`).join(', ')}: cost-of-sales line left with no project (CC2).`]
    : [];
  return { lines, unchanged, isRestatement: lines.some((l) => l.periodClosed), warnings };
}
