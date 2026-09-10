import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import type { JournalLineInput } from '../../types/gl.types';

export type DimensionAssignmentMode = 'new-assignment' | 'historical-copy';

type AnalysisDimensions = Pick<JournalLineInput, 'cc1Id' | 'cc2Id' | 'buId'>;
type CostCentreRow = { id: string; cc_type: string | null; is_active: boolean | null };
type BusinessUnitRow = { id: string; is_active: boolean | null };

const suppliedIds = (
  values: readonly unknown[],
  message: string,
): string[] => {
  const ids: string[] = [];
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error(message);
    ids.push(value.toLowerCase());
  }
  return [...new Set(ids)];
};

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
  const cc1Message = 'CC1 must name an active CC1 cost centre in this company';
  const cc2Message = 'CC2 must name an active CC2 cost centre in this company';
  const buMessage = 'Business unit must be active and belong to this company';
  const cc1Ids = suppliedIds(lines.map((line) => line.cc1Id), cc1Message);
  const cc2Ids = suppliedIds(lines.map((line) => line.cc2Id), cc2Message);
  const buIds = suppliedIds(lines.map((line) => line.buId), buMessage);

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
  const assignable = (id: string, type: 'cc1' | 'cc2'): boolean => {
    const row = costCentres.get(id);
    return row?.cc_type === type && (mode === 'historical-copy' || row.is_active === true);
  };
  if (cc1Ids.some((id) => !assignable(id, 'cc1'))) throw new Error(cc1Message);
  if (cc2Ids.some((id) => !assignable(id, 'cc2'))) throw new Error(cc2Message);

  if (buIds.length > 0) {
    const rows = (await sql`
      SELECT id, is_active FROM business_units
      WHERE company_id = ${companyId}::UUID AND id = ANY(${buIds}::UUID[])
      FOR SHARE
    `) as BusinessUnitRow[];
    const businessUnits = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));
    if (buIds.some((id) => {
      const row = businessUnits.get(id);
      return row === undefined || (mode === 'new-assignment' && row.is_active !== true);
    })) throw new Error(buMessage);
  }
}
