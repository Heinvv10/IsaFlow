import type { ControlTx, EntityRef } from './contracts';
import { assertControlTx } from './context';

/** The lineage an entity is read and extended under: the canonical (lowercase) spelling when it was retained, else
 * the only retained spelling. Two retained spellings, neither canonical, are two lineages and refuse. The caller's own
 * spelling never decides, so a raw-id writer extends the same lineage every projection reports. Every version reader
 * and recordCommittedChange choose through this, so the version read and the row extended are the same lineage. */
export function retainedLineage<T extends { entity_id: string }>(rows: readonly T[], entityId: string): T | undefined {
  const canonical = entityId.toLowerCase();
  const matches = rows.filter(row => row.entity_id.toLowerCase() === canonical);
  const exact = matches.find(row => row.entity_id === canonical);
  if (exact) return exact;
  if (matches.length > 1) throw new Error('Ambiguous control entity version');
  return matches[0];
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
      AND lower(entity_id)=lower(${ref.entityId}) ORDER BY (entity_id=lower(${ref.entityId})) DESC,entity_id LIMIT 2`) as
    { entity_id: string; version: string | number; material_hash: string }[];
  const row = retainedLineage(rows, ref.entityId);
  if (!row) return null;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid stored control version');
  return { version, materialHash: row.material_hash };
}
