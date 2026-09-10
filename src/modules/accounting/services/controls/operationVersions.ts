import type { ControlTx, EntityRef } from './contracts';
import { assertControlTx } from './context';

/** Null means untracked history; this read never invents or persists a baseline. */
export async function readControlEntityVersion(ctx: ControlTx, ref: EntityRef): Promise<{
  version: number; materialHash: string;
} | null> {
  assertControlTx(ctx);
  // A lineage retained before entity_id canonicalization keeps its own spelling. The caller's spelling
  // wins when it was retained; otherwise the single retained spelling is the lineage, and two are ambiguous.
  const rows = (await ctx.sql`SELECT entity_id,version,material_hash FROM control_entity_versions
    WHERE company_id=${ctx.principal.companyId}::uuid AND entity_type=${ref.entityType}
      AND lower(entity_id)=lower(${ref.entityId}) ORDER BY (entity_id=${ref.entityId}) DESC,entity_id LIMIT 2`) as
    { entity_id: string; version: string | number; material_hash: string }[];
  if (rows.length > 1 && rows[0]!.entity_id !== ref.entityId) throw new Error('Ambiguous control entity version');
  if (!rows[0]) return null;
  const version = Number(rows[0].version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid stored control version');
  return { version, materialHash: rows[0].material_hash };
}
