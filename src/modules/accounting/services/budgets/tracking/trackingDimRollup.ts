/**
 * Which budget rows a dimension filter takes (budgets P3 spec §2.4). Pure.
 *
 * A budget row is set at ONE grain per account and version (contract decision
 * 4, `budget_month_amounts_one_grain`) and names at most one dimension
 * (`budget_month_amounts_one_dimension`). Its EFFECTIVE dimensions add the
 * FNO a CC2 rolls up to, by the parent walk postings use
 * (`gl/dimensions/dimensionDerivation.deriveFnoId`).
 *
 * Under a filter every row is exactly one of:
 *   - included: every level the filter names matches;
 *   - coarser: set ABOVE the filter (a level it names is NULL on the row, and
 *     nothing conflicts). Reported as unallocated budget, NEVER apportioned: a
 *     pro-rata split is a number nobody set;
 *   - other: some named level conflicts; excluded.
 *
 * A CC2 filter also knows its project's FNO: a CC1-grain row of THAT FNO is
 * above the project (coarser); a CC1-grain row of another FNO is not above it
 * and is excluded. Reading the §2.4 table literally (only the named level
 * counts) would put every other FNO's budget in the project's "unallocated"
 * footer, which says it is set above this filter when it is not.
 *
 * Either level (`cost_centre_id`, the statement pages' meaning, for the PR-C
 * comparator) matches `eff.cc1 = X OR eff.cc2 = X`; otherwise it is the
 * explicit filter of X's own level.
 */
import { deriveFnoId, type CostCentreNode } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';

export type BudgetRowClass = 'included' | 'coarser' | 'other';

export interface EffDims {
  cc1: string | null;
  cc2: string | null;
  bu: string | null;
}

/** A project filter carries its FNO (null: no chain). */
export interface ProjectRef { id: string; fno: string | null }

export interface BudgetFilter {
  cc1?: string;
  cc2?: ProjectRef;
  bu?: string;
  costCentre?: { id: string; level: 'cc1' | 'cc2'; fno: string | null };
}

const lower = (id: string | null): string | null => (id ? id.toLowerCase() : null);

/** A row's effective dimensions; a stored CC1 that contradicts its CC2's chain is a data error and throws. */
export function effectiveDims(
  row: { cc1Id: string | null; cc2Id: string | null; buId: string | null },
  nodes: ReadonlyMap<string, CostCentreNode>,
): EffDims {
  const cc1 = lower(row.cc1Id);
  const cc2 = lower(row.cc2Id);
  const derived = cc2 ? deriveFnoId(cc2, nodes) : null;
  if (cc1 && derived && cc1 !== derived) {
    throw new Error(`budget row cc1 ${cc1} contradicts the FNO ${derived} its cc2 ${cc2} rolls up to`);
  }
  return { cc1: cc1 ?? derived, cc2, bu: lower(row.buId) };
}

type Verdict = 'match' | 'coarser' | 'other';

function level(value: string | null, wanted: string): Verdict {
  if (value === null) return 'coarser';
  return value === wanted ? 'match' : 'other';
}

function project(eff: EffDims, p: ProjectRef): Verdict {
  if (eff.cc2 !== null) return eff.cc2 === p.id ? 'match' : 'other';
  // Set at an FNO (or above): above this project only when it is the project's own FNO.
  if (eff.cc1 !== null && eff.cc1 !== p.fno) return 'other';
  return 'coarser';
}

/** The class of one budget row under `f` (an empty filter includes every row). */
export function classifyBudgetRow(eff: EffDims, f: BudgetFilter): BudgetRowClass {
  const verdicts: Verdict[] = [];
  if (f.cc1 !== undefined) verdicts.push(level(eff.cc1, f.cc1));
  if (f.cc2 !== undefined) verdicts.push(project(eff, f.cc2));
  if (f.bu !== undefined) verdicts.push(level(eff.bu, f.bu));
  if (f.costCentre !== undefined) {
    const x = f.costCentre;
    if (eff.cc1 === x.id || eff.cc2 === x.id) verdicts.push('match');
    else verdicts.push(x.level === 'cc1' ? level(eff.cc1, x.id) : project(eff, { id: x.id, fno: x.fno }));
  }
  if (verdicts.includes('other')) return 'other';
  if (verdicts.includes('coarser')) return 'coarser';
  return 'included';
}

/** True when the filter names any level. */
export function isFiltered(f: BudgetFilter): boolean {
  return f.cc1 !== undefined || f.cc2 !== undefined || f.bu !== undefined || f.costCentre !== undefined;
}
