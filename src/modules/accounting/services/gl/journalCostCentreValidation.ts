import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import type { JournalLineInput } from '../../types/gl.types';

/**
 * A CC1 / CC2 / business-unit assignment the writer refuses (inactive, wrong slot, not this company's, not a UUID): a
 * typed validation error, so a caller can show its message and treat every OTHER failure (a database error) as a fault.
 * Still an `Error` with the same message as before for every existing caller.
 */
export class JournalDimensionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalDimensionValidationError';
  }
}

export type DimensionAssignmentMode = 'new-assignment' | 'historical-copy';

type AnalysisDimensions = Pick<JournalLineInput, 'cc1Id' | 'cc2Id' | 'buId'>;
type CostCentreRow = { id: string; cc_type: string | null; is_active: boolean | null };
type BusinessUnitRow = { id: string; is_active: boolean | null };

/** The distinct ids supplied, or null when one is not a UUID (the caller then reports its message). */
const suppliedIds = (values: readonly unknown[]): string[] | null => {
  const ids: string[] = [];
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !UUID_RE.test(value)) return null;
    ids.push(value.toLowerCase());
  }
  return [...new Set(ids)];
};

/**
 * THE rule for whether a cost centre may take a slot: its type is exactly the slot's, and (for a new assignment) it
 * is active, strictly `true` — a NULL type or NULL flag is not assignable. Shared with the classified bank import.
 */
export function isAssignableCostCentre(
  row: { cc_type: string | null; is_active: boolean | null } | undefined,
  type: 'cc1' | 'cc2',
  mode: DimensionAssignmentMode = 'new-assignment',
): boolean {
  return row?.cc_type === type && (mode === 'historical-copy' || row.is_active === true);
}

/** Whether a business unit may be assigned: it exists, and (for a new assignment) is strictly active. */
export function isAssignableBusinessUnit(
  row: { is_active: boolean | null } | undefined,
  mode: DimensionAssignmentMode = 'new-assignment',
): boolean {
  return row !== undefined && (mode === 'historical-copy' || row.is_active === true);
}

/**
 * Validate CC1, CC2 and business-unit assignments at their shared write boundary.
 * New assignments must be active and in the correct slot. Historical copy paths
 * retain owned inactive references so reversals and reclassifications keep
 * netting in the same reporting bucket.
 */
export async function assertJournalAnalysisDimensions(
  companyId: string,
  lines: readonly AnalysisDimensions[],
  mode: DimensionAssignmentMode = 'new-assignment',
): Promise<void> {
  const problem = await journalAnalysisDimensionProblem(companyId, lines, mode);
  if (problem !== null) throw new JournalDimensionValidationError(problem);
}

/**
 * The same validation as `assertJournalAnalysisDimensions`, returned as the refusal's text (null when every
 * assignment is usable) so a caller that wants a TYPED refusal before its first write can raise its own class
 * without matching on a message. Takes the masters FOR SHARE, as the assertion does.
 */
export async function journalAnalysisDimensionProblem(
  companyId: string,
  lines: readonly AnalysisDimensions[],
  mode: DimensionAssignmentMode = 'new-assignment',
): Promise<string | null> {
  const cc1Message = 'CC1 must name an active CC1 cost centre in this company';
  const cc2Message = 'CC2 must name an active CC2 cost centre in this company';
  const buMessage = 'Business unit must be active and belong to this company';
  const cc1Ids = suppliedIds(lines.map((line) => line.cc1Id));
  if (cc1Ids === null) return cc1Message;
  const cc2Ids = suppliedIds(lines.map((line) => line.cc2Id));
  if (cc2Ids === null) return cc2Message;
  const buIds = suppliedIds(lines.map((line) => line.buId));
  if (buIds === null) return buMessage;

  const costCentreIds = [...new Set([...cc1Ids, ...cc2Ids])];
  let costCentres = new Map<string, CostCentreRow>();
  if (costCentreIds.length > 0) {
    const rows = (await sql`
      SELECT id, cc_type, is_active FROM cost_centres
      WHERE company_id = ${companyId}::UUID AND id = ANY(${costCentreIds}::UUID[])
      FOR SHARE
    `) as CostCentreRow[];
    costCentres = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));
  }
  const assignable = (id: string, type: 'cc1' | 'cc2'): boolean => isAssignableCostCentre(costCentres.get(id), type, mode);
  if (cc1Ids.some((id) => !assignable(id, 'cc1'))) return cc1Message;
  if (cc2Ids.some((id) => !assignable(id, 'cc2'))) return cc2Message;

  if (buIds.length > 0) {
    const rows = (await sql`
      SELECT id, is_active FROM business_units
      WHERE company_id = ${companyId}::UUID AND id = ANY(${buIds}::UUID[])
      FOR SHARE
    `) as BusinessUnitRow[];
    const businessUnits = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));
    if (buIds.some((id) => !isAssignableBusinessUnit(businessUnits.get(id), mode))) return buMessage;
  }
  return null;
}
