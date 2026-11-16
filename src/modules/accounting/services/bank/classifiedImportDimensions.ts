/**
 * The cost centres a classified worksheet names, resolved to the line's own dimension columns (audit WP2 row 9).
 *
 * The worksheet carries `costCentreT1`, `costCentreT2` and `businessUnit` as text. The classified import used to join
 * T1 and T2 into one string for `bank_transactions.suggested_cost_centre`, a column no migration ever created — so
 * every import that inserted a line failed. The values belong in the columns a line's saved dimensions live in
 * (`cc1_id`, `cc2_id`, `bu_id`: what the dimension picker saves and an allocation reads), so each is resolved here to
 * a master this company may ASSIGN in that slot — the journal writer's own rule (`isAssignableCostCentre`: cc_type
 * exactly the slot's, is_active exactly true; a NULL type or flag is not assignable) — by code or by name (exact,
 * case-insensitive). A value that resolves to nothing, or to more than one master, is left NULL and reported back,
 * never guessed. An INACTIVE master that shares a label does not make it ambiguous (it is not a candidate). The masters it names are read FOR SHARE (as `assertJournalAnalysisDimensions` reads them, under the request's
 * lock wait): one deactivated between this read and the INSERT waits for the import, so it cannot be attached.
 */
import { sql } from '@/lib/neon';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';
import { isAssignableBusinessUnit, isAssignableCostCentre } from '../gl/journalCostCentreValidation';

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
 * "T2: <label>" / "BU: <label>". Company-scoped reads, whatever the number of rows.
 */
export async function resolveWorksheetDimensions(
  companyId: string, rows: readonly WorksheetDimensions[],
): Promise<{ dimensions: DimensionIds[]; unresolved: string[] }> {
  const named = rows.some((r) => r.costCentreT1?.trim() || r.costCentreT2?.trim() || r.businessUnit?.trim());
  if (!named) return { dimensions: rows.map(() => ({})), unresolved: [] };
  // Ambiguity needs EVERY assignable candidate, so the masters are read first, unlocked.
  const centres = (await sql`
    SELECT id::TEXT AS id, code, name, cc_type, is_active FROM cost_centres
    WHERE company_id = ${companyId}::UUID`) as Row[];
  const units = (await sql`
    SELECT id::TEXT AS id, code, name, is_active FROM business_units
    WHERE company_id = ${companyId}::UUID`) as Row[];
  const asMaster = (r: Row): Master => ({ id: String(r.id), code: String(r.code ?? ''), name: String(r.name ?? '') });
  const centreOf = (r: Row) => ({ cc_type: r.cc_type as string | null, is_active: r.is_active as boolean | null });
  const indexes = (cs: Row[], us: Row[]) => ({
    cc1: indexOf(cs.filter((r) => isAssignableCostCentre(centreOf(r), 'cc1')).map(asMaster)),
    cc2: indexOf(cs.filter((r) => isAssignableCostCentre(centreOf(r), 'cc2')).map(asMaster)),
    bu: indexOf(us.filter((r) => isAssignableBusinessUnit({ is_active: r.is_active as boolean | null })).map(asMaster)),
  });
  const labelled = (dim: (r: WorksheetDimensions) => string | undefined, ix: Map<string, string | null>) =>
    rows.flatMap((r) => { const l = dim(r)?.trim(); const id = l ? ix.get(key(l)) : undefined; return id ? [id] : []; });
  const first = indexes(centres, units);
  const matchedCentres = [...new Set([
    ...labelled((r) => r.costCentreT1, first.cc1), ...labelled((r) => r.costCentreT2, first.cc2)])];
  const matchedUnits = [...new Set(labelled((r) => r.businessUnit, first.bu))];
  // Only the masters this file actually names are locked (FOR SHARE: one deactivated between this read and the INSERT
  // waits for the import, so it cannot be attached), and their state is re-read under the lock. An unrelated master
  // stays editable.
  const lockedCentres = matchedCentres.length === 0 ? [] : (await sql`
    SELECT id::TEXT AS id, code, name, cc_type, is_active FROM cost_centres
    WHERE company_id = ${companyId}::UUID AND id = ANY(${matchedCentres}::UUID[]) ORDER BY id FOR SHARE`) as Row[];
  const lockedUnits = matchedUnits.length === 0 ? [] : (await sql`
    SELECT id::TEXT AS id, code, name, is_active FROM business_units
    WHERE company_id = ${companyId}::UUID AND id = ANY(${matchedUnits}::UUID[]) ORDER BY id FOR SHARE`) as Row[];
  // Re-decided under the lock, from the CURRENT masters that answer to this file's labels (one read per table, keyed
  // by the labels): a twin activated, or a master re-typed, since the first read can make a label ambiguous or
  // resolve it to a master that is not locked. Such a label is unresolved, never guessed.
  const labels = [...new Set(rows.flatMap((r) => [r.costCentreT1, r.costCentreT2, r.businessUnit])
    .flatMap((v) => (v?.trim() ? [key(v)] : [])))];
  const nowCentres = (await sql`
    SELECT id::TEXT AS id, code, name, cc_type, is_active FROM cost_centres
    WHERE company_id = ${companyId}::UUID AND (lower(btrim(code)) = ANY(${labels}::TEXT[]) OR lower(btrim(name)) = ANY(${labels}::TEXT[]))`) as Row[];
  const nowUnits = (await sql`
    SELECT id::TEXT AS id, code, name, is_active FROM business_units
    WHERE company_id = ${companyId}::UUID AND (lower(btrim(code)) = ANY(${labels}::TEXT[]) OR lower(btrim(name)) = ANY(${labels}::TEXT[]))`) as Row[];
  const { cc1, cc2, bu } = indexes(nowCentres, nowUnits);
  const locked = new Set([...lockedCentres, ...lockedUnits].map((r) => String(r.id)));

  const unresolved = new Set<string>();
  const pick = (index: Map<string, string | null>, value: string | undefined, slot: string): string | undefined => {
    const label = value?.trim();
    if (!label) return undefined;
    const found = index.get(key(label));
    const id = found && locked.has(found) ? found : null;
    if (!id) unresolved.add(`${slot}: ${label}`);
    return id ?? undefined;
  };
  const dimensions = rows.map((r) => ({
    cc1Id: pick(cc1, r.costCentreT1, 'T1'), cc2Id: pick(cc2, r.costCentreT2, 'T2'), buId: pick(bu, r.businessUnit, 'BU'),
  }));
  return { dimensions, unresolved: [...unresolved] };
}
