/**
 * The cost centres a classified worksheet names, resolved to the line's own dimension columns (audit WP2 row 9).
 *
 * The worksheet carries `costCentreT1`, `costCentreT2` and `businessUnit` as text. The classified import used to join
 * T1 and T2 into one string for `bank_transactions.suggested_cost_centre`, a column no migration ever created — so
 * every import that inserted a line failed. The values belong in the columns a line's saved dimensions live in
 * (`cc1_id`, `cc2_id`, `bu_id`: what the dimension picker saves and an allocation reads), so each is resolved here to
 * an ACTIVE master of its own slot in this company, by code or by name (exact, case-insensitive). A value that
 * resolves to nothing — or to more than one master — is left NULL and reported back, never guessed.
 */
import { sql } from '@/lib/neon';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';

export interface WorksheetDimensions { costCentreT1?: string; costCentreT2?: string; businessUnit?: string }

type Master = { id: string; code: string; name: string };
type Row = Record<string, unknown>;

const key = (v: string): string => v.trim().toLowerCase();

/** label → id for one slot; a label two masters answer to is ambiguous and maps to null. */
function indexOf(masters: Master[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const m of masters) {
    for (const label of new Set([key(m.code), key(m.name)])) {
      if (!label) continue;
      index.set(label, index.has(label) && index.get(label) !== m.id ? null : m.id);
    }
  }
  return index;
}

/**
 * One `DimensionIds` per input row (same order), and the labels that resolved to nothing, as "T1: <label>" /
 * "T2: <label>" / "BU: <label>". Two company-scoped reads, whatever the number of rows.
 */
export async function resolveWorksheetDimensions(
  companyId: string, rows: readonly WorksheetDimensions[],
): Promise<{ dimensions: DimensionIds[]; unresolved: string[] }> {
  const named = rows.some((r) => r.costCentreT1?.trim() || r.costCentreT2?.trim() || r.businessUnit?.trim());
  if (!named) return { dimensions: rows.map(() => ({})), unresolved: [] };
  const centres = (await sql`
    SELECT id::TEXT AS id, code, name, COALESCE(cc_type, 'cc1') AS cc_type FROM cost_centres
    WHERE company_id = ${companyId}::UUID AND is_active = true`) as Row[];
  const units = (await sql`
    SELECT id::TEXT AS id, code, name FROM business_units
    WHERE company_id = ${companyId}::UUID AND is_active IS NOT FALSE`) as Row[];
  const asMaster = (r: Row): Master => ({ id: String(r.id), code: String(r.code ?? ''), name: String(r.name ?? '') });
  const cc1 = indexOf(centres.filter((r) => r.cc_type === 'cc1').map(asMaster));
  const cc2 = indexOf(centres.filter((r) => r.cc_type === 'cc2').map(asMaster));
  const bu = indexOf(units.map(asMaster));

  const unresolved = new Set<string>();
  const pick = (index: Map<string, string | null>, value: string | undefined, slot: string): string | undefined => {
    const label = value?.trim();
    if (!label) return undefined;
    const id = index.get(key(label));
    if (!id) unresolved.add(`${slot}: ${label}`);
    return id ?? undefined;
  };
  const dimensions = rows.map((r) => ({
    cc1Id: pick(cc1, r.costCentreT1, 'T1'), cc2Id: pick(cc2, r.costCentreT2, 'T2'), buId: pick(bu, r.businessUnit, 'BU'),
  }));
  return { dimensions, unresolved: [...unresolved] };
}
