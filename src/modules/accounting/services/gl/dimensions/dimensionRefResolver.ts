/**
 * Resolve what a caller TYPED for a dimension — a UUID, a code, or an alias —
 * to the canonical id, company-scoped, in at most three queries per batch.
 *
 * Order per reference: a UUID matches an id; otherwise an exact code; otherwise
 * a case-insensitive code that is unique; otherwise (cost centres only) an
 * alias from cost_centre_aliases ("Ben Farms" -> Phalaborwa - Ben Farms, brief
 * §5.3). The resolved row must sit in the slot asked for (a CC2 reference that
 * names a CC1 is refused, brief §5.5 "dimensions never substitute for one
 * another") and be active, because this is a NEW assignment.
 *
 * A foreign id reads exactly like a miss — no existence oracle.
 */
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { DimensionRefusal, type DimensionIds, type DimensionKind, type DimensionRefs } from './dimensionTypes';

interface MasterRow { id: string; code: string; cc_type?: string | null; is_active: boolean | null }
interface AliasRow { alias_normalized: string; id: string; code: string; cc_type: string | null; is_active: boolean | null }

/** The one normal form an alias is stored and looked up under. */
export function aliasKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

const KIND_LABEL: Record<DimensionKind, string> = {
  cc1: 'an active CC1 (FNO) cost centre',
  cc2: 'an active CC2 (project) cost centre',
  bu: 'an active business unit',
};

/** Pure: pick the master row a reference names, or null. */
export function matchMasterRow(ref: string, rows: readonly MasterRow[]): MasterRow | null {
  if (UUID_RE.test(ref)) return rows.find((r) => r.id.toLowerCase() === ref.toLowerCase()) ?? null;
  const exact = rows.filter((r) => r.code === ref);
  if (exact.length === 1) return exact[0]!;
  const folded = rows.filter((r) => r.code.toLowerCase() === ref.toLowerCase());
  return folded.length === 1 ? folded[0]! : null;
}

function refsOf(lines: readonly (DimensionRefs | undefined)[], kinds: DimensionKind[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    for (const kind of kinds) {
      const v = line?.[kind];
      if (typeof v === 'string' && v.trim()) out.add(v.trim());
    }
  }
  return [...out];
}

async function costCentreRows(companyId: string, refs: string[]): Promise<MasterRow[]> {
  if (refs.length === 0) return [];
  const ids = refs.filter((r) => UUID_RE.test(r));
  const codes = refs.filter((r) => !UUID_RE.test(r)).map((r) => r.toLowerCase());
  return (await sql`
    SELECT id::TEXT AS id, code, cc_type, is_active FROM cost_centres
    WHERE company_id = ${companyId}::UUID
      AND (id = ANY(${ids}::UUID[]) OR lower(code) = ANY(${codes}::TEXT[]))
  `) as MasterRow[];
}

async function aliasRows(companyId: string, refs: string[]): Promise<AliasRow[]> {
  if (refs.length === 0) return [];
  const keys = [...new Set(refs.map(aliasKey))];
  return (await sql`
    SELECT a.alias_normalized, cc.id::TEXT AS id, cc.code, cc.cc_type, cc.is_active
    FROM cost_centre_aliases a
    JOIN cost_centres cc ON cc.id = a.cost_centre_id AND cc.company_id = a.company_id
    WHERE a.company_id = ${companyId}::UUID AND a.alias_normalized = ANY(${keys}::TEXT[])
  `) as AliasRow[];
}

async function businessUnitRows(companyId: string, refs: string[]): Promise<MasterRow[]> {
  if (refs.length === 0) return [];
  const ids = refs.filter((r) => UUID_RE.test(r));
  const codes = refs.filter((r) => !UUID_RE.test(r)).map((r) => r.toLowerCase());
  return (await sql`
    SELECT id::TEXT AS id, code, is_active FROM business_units
    WHERE company_id = ${companyId}::UUID
      AND (id = ANY(${ids}::UUID[]) OR lower(code) = ANY(${codes}::TEXT[]))
  `) as MasterRow[];
}

/**
 * Resolve every line's refs. Returns one entry per input line (undefined where
 * the line named no dimension). Throws DimensionRefusal naming the first bad
 * reference as `<label(i)>.<kind>`.
 */
export async function resolveDimensionRefs(
  companyId: string,
  lines: readonly (DimensionRefs | undefined)[],
  label: (index: number) => string = (i) => `lines[${i}]`,
): Promise<(DimensionIds | undefined)[]> {
  const ccRefs = refsOf(lines, ['cc1', 'cc2']);
  const buRefs = refsOf(lines, ['bu']);
  const ccRows = await costCentreRows(companyId, ccRefs);
  const unmatched = ccRefs.filter((r) => !UUID_RE.test(r) && !matchMasterRow(r, ccRows));
  const aliases = await aliasRows(companyId, unmatched);
  const buRows = await businessUnitRows(companyId, buRefs);

  const resolveCc = (ref: string): MasterRow | null => matchMasterRow(ref, ccRows)
    ?? (UUID_RE.test(ref) ? null : aliases.find((a) => a.alias_normalized === aliasKey(ref)) ?? null);

  return lines.map((line, i) => {
    if (!line) return undefined;
    const out: DimensionIds = {};
    for (const kind of ['cc1', 'cc2', 'bu'] as const) {
      const ref = line[kind]?.trim();
      if (!ref) continue;
      const row = kind === 'bu' ? matchMasterRow(ref, buRows) : resolveCc(ref);
      const fits = row !== null && row.is_active === true && (kind === 'bu' || row.cc_type === kind);
      if (!fits) {
        throw new DimensionRefusal(`${label(i)}.${kind} "${ref}" does not name ${KIND_LABEL[kind]} in this company`);
      }
      if (kind === 'cc1') out.cc1Id = row.id;
      else if (kind === 'cc2') out.cc2Id = row.id;
      else out.buId = row.id;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  });
}
