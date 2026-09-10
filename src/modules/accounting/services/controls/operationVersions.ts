import type { ControlTx, EntityRef } from './contracts';
import { assertControlTx } from './context';

/** The lineage an entity is read and extended under: the most advanced retained spelling (highest version), the
 * canonical (lowercase) spelling on a tie at that version. That lineage is where the entity's current state and its
 * version-keyed dependent rows (payroll calculation versions and the like) live, so extending any other strands real
 * work. Every projection orders the same way (version DESC, canonical first), so writers and snapshots agree. A tie at
 * the highest version with no canonical spelling is ambiguous: writers refuse it, projections flag it. */
export function lineageChoice<T extends { entity_id: string; version: number | string }>(rows: readonly T[], entityId: string):
  { row: T | undefined; forked: boolean; ambiguous: boolean } {
  const canonical = entityId.toLowerCase();
  const matches = rows.filter(row => row.entity_id.toLowerCase() === canonical)
    .sort((a, b) => Number(b.version) - Number(a.version) || Number(b.entity_id === canonical) - Number(a.entity_id === canonical));
  const [top, next] = matches;
  const ambiguous = !!top && !!next && Number(next.version) === Number(top.version) && top.entity_id !== canonical;
  return { row: ambiguous ? undefined : top, forked: matches.length > 1, ambiguous };
}
export function retainedLineage<T extends { entity_id: string; version: number | string }>(rows: readonly T[], entityId: string): T | undefined {
  const choice = lineageChoice(rows, entityId);
  if (choice.ambiguous) throw new Error('Ambiguous control entity version');
  return choice.row;
}

/** Null means untracked history; this read never invents or persists a baseline. */
export async function readControlEntityVersion(ctx: ControlTx, ref: EntityRef): Promise<{
  version: number; materialHash: string;
} | null> {
  assertControlTx(ctx);
  // A lineage retained before entity_id canonicalization keeps its own spelling. The caller's spelling
  // wins when it was retained; otherwise the single retained spelling is the lineage, and two are ambiguous.
  const rows = (await ctx.sql`SELECT entity_id,version,material_hash FROM control_entity_versions
    WHERE company_id=${ctx.principal.companyId}::uuid AND entity_type=${ref.entityType}
      AND lower(entity_id)=lower(${ref.entityId}) ORDER BY version DESC,(entity_id=lower(${ref.entityId})) DESC,entity_id LIMIT 2`) as
    { entity_id: string; version: string | number; material_hash: string }[];
  const row = retainedLineage(rows, ref.entityId);
  if (!row) return null;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid stored control version');
  return { version, materialHash: row.material_hash };
}
