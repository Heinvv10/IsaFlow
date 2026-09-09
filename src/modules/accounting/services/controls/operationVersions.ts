import type { ControlTx, EntityRef } from './contracts';
import { assertControlTx } from './context';

/** Null means untracked history; this read never invents or persists a baseline. */
export async function readControlEntityVersion(ctx: ControlTx, ref: EntityRef): Promise<{
  version: number; materialHash: string;
} | null> {
  assertControlTx(ctx);
  const rows = (await ctx.sql`SELECT version,material_hash FROM control_entity_versions
    WHERE company_id=${ctx.principal.companyId}::uuid AND entity_type=${ref.entityType} AND entity_id=${ref.entityId}`) as
    { version: string | number; material_hash: string }[];
  if (!rows[0]) return null;
  const version = Number(rows[0].version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid stored control version');
  return { version, materialHash: rows[0].material_hash };
}
