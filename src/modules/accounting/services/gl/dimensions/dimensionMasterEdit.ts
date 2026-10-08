/**
 * Edit and delete for the CC1 / CC2 master, under the same ladder rules the
 * create path enforces (dimensionMasterService):
 *   - a CC1 takes no parent; a CC2's parent is an active CC1, or an active
 *     programme CC2 whose chain reaches a CC1 — and never itself or a descendant;
 *   - a code or alias may not equal another cost centre's code or alias;
 *   - a node with active children cannot be deactivated, and a node under an
 *     inactive parent cannot be reactivated.
 *
 * Moving a CC2 (or a programme, with its subtree) under another FNO is refused
 * while anything carries it: every tagged line, document and default stored the
 * CC1 derived when it was written, so the move would leave that CC1 wrong. Re-tag
 * first, then move.
 *
 * Every refusal is a DimensionRefusal raised from reads, before the first write.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertCostCentreUnused, countCc2Carriers } from '../../core/costCentreUsageGuard';
import { deleteCostCentre } from '../../core/costCentreService';
import { listDimensionCostCentres, type DimensionCostCentre } from './dimensionMasterService';
import { aliasKey } from './dimensionRefResolver';
import { DimensionRefusal } from './dimensionTypes';

/** By UUID, code or alias (case-insensitive), active or not. */
export function findDimensionCostCentre(all: DimensionCostCentre[], ref: string): DimensionCostCentre | undefined {
  const key = aliasKey(ref);
  return all.find((c) => c.id === ref.trim())
    ?? all.find((c) => c.code.toLowerCase() === key)
    ?? all.find((c) => c.aliases.some((a) => aliasKey(a) === key));
}

function descendantsOf(all: DimensionCostCentre[], id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const c of all) {
      if (c.parentId === cur && !out.includes(c.id)) { out.push(c.id); queue.push(c.id); }
    }
  }
  return out;
}

/** undefined leaves a field as it is; null clears parent / description / department. */
export interface UpdateDimensionCostCentreInput {
  code?: string;
  name?: string;
  /** CC2 only: the new parent (code, UUID or alias); null detaches it. */
  parent?: string | null;
  /** Replaces the whole alias set. */
  aliases?: string[];
  addAliases?: string[];
  removeAliases?: string[];
  description?: string | null;
  department?: string | null;
  isActive?: boolean;
}

export interface UpdateDimensionCostCentrePlan {
  before: DimensionCostCentre;
  after: {
    code: string; name: string; parentId: string | null; parentCode: string | null; fnoCode: string | null;
    isActive: boolean; description: string | null; department: string | null;
  };
  addAliases: { alias: string; key: string }[];
  removeAliasKeys: string[];
  changed: string[];
  warnings: string[];
}

function cleanText(v: string | null | undefined, old: string | null): string | null {
  if (v === undefined) return old;
  return v === null || !v.trim() ? null : v.trim();
}

function dedupeAliases(list: string[]): { alias: string; key: string }[] {
  return [...new Map(list.map((a) => a.trim()).filter(Boolean).map((a) => [aliasKey(a), a])).entries()]
    .map(([key, alias]) => ({ alias, key }));
}

/** Every refusal, from reads only. */
export async function planUpdateDimensionCostCentre(
  companyId: string,
  ref: string,
  input: UpdateDimensionCostCentreInput,
): Promise<UpdateDimensionCostCentrePlan> {
  const all = await listDimensionCostCentres(companyId, { includeInactive: true });
  const before = findDimensionCostCentre(all, ref);
  if (!before) throw new DimensionRefusal(`cost centre "${ref}" does not exist in this company`);
  const others = all.filter((c) => c.id !== before.id);
  const takenBy = (key: string) => others.find((c) => c.code.toLowerCase() === key || c.aliases.some((a) => aliasKey(a) === key));

  const code = input.code === undefined ? before.code : input.code.trim();
  const name = input.name === undefined ? before.name : input.name.trim();
  if (!code || code.length > 20) throw new DimensionRefusal('code is required and at most 20 characters');
  if (!name || name.length > 255) throw new DimensionRefusal('name is required and at most 255 characters');
  if (code.toLowerCase() !== before.code.toLowerCase()) {
    const clash = takenBy(code.toLowerCase());
    if (clash) throw new DimensionRefusal(`code ${code} is already the code or an alias of ${clash.code}`);
  }

  const warnings: string[] = [];
  let parentId = before.parentId;
  let parentCode = before.parentCode;
  let fnoCode = before.ccType === 'cc1' ? code : before.fnoCode;
  if (input.parent !== undefined) {
    if (before.ccType === 'cc1' && input.parent !== null) {
      throw new DimensionRefusal('A CC1 (FNO) is the top of the project ladder and takes no parent');
    }
    if (input.parent === null) {
      parentId = null; parentCode = null; fnoCode = before.ccType === 'cc1' ? code : null;
    } else {
      const parent = findDimensionCostCentre(all, input.parent);
      if (!parent || !parent.isActive) throw new DimensionRefusal(`parent "${input.parent}" does not name an active CC1 or CC2 in this company`);
      if (parent.id === before.id || descendantsOf(all, before.id).includes(parent.id)) {
        throw new DimensionRefusal(`parent "${input.parent}" is ${before.code} itself or below it — that would make a loop`);
      }
      if (!parent.fnoCode) throw new DimensionRefusal(`parent "${input.parent}" is a CC2 whose chain reaches no CC1 (FNO) — fix the programme first`);
      parentId = parent.id; parentCode = parent.code; fnoCode = parent.fnoCode;
    }
    if (before.ccType === 'cc2' && fnoCode !== before.fnoCode) {
      const subtree = [before.id, ...descendantsOf(all, before.id)];
      const carriers = await countCc2Carriers(companyId, subtree);
      if (carriers > 0) {
        throw new DimensionRefusal(
          `Moving ${before.code} from FNO ${before.fnoCode ?? '(none)'} to ${fnoCode ?? '(none)'} would leave the CC1 wrong on `
          + `${carriers} line(s), document(s), default(s) or tag batch line(s) that carry it (or a project below it). Re-tag them first.`,
        );
      }
    }
    if (before.ccType === 'cc2' && !fnoCode) warnings.push(`CC2 ${code} has no parent, so no FNO can be derived for it.`);
  }

  const isActive = input.isActive ?? before.isActive;
  if (!isActive && before.isActive) {
    const activeChildren = all.filter((c) => c.parentId === before.id && c.isActive);
    if (activeChildren.length > 0) {
      throw new DimensionRefusal(`${before.code} has active children (${activeChildren.map((c) => c.code).join(', ')}) — deactivate or move them first`);
    }
  }
  if (isActive && parentId) {
    const parent = all.find((c) => c.id === parentId);
    if (parent && !parent.isActive) throw new DimensionRefusal(`${before.code} sits under inactive ${parent.code} — activate or change the parent first`);
  }

  const current = dedupeAliases(before.aliases);
  let target = current;
  if (input.aliases !== undefined) {
    target = dedupeAliases(input.aliases);
  } else if (input.addAliases?.length || input.removeAliases?.length) {
    const removeKeys = (input.removeAliases ?? []).map(aliasKey);
    const missing = (input.removeAliases ?? []).filter((a) => !current.some((c) => c.key === aliasKey(a)));
    if (missing.length > 0) throw new DimensionRefusal(`${before.code} has no alias ${missing.map((m) => `"${m}"`).join(', ')}`);
    target = dedupeAliases([...current.filter((c) => !removeKeys.includes(c.key)).map((c) => c.alias), ...(input.addAliases ?? [])]);
  }
  if (target.some((a) => a.key.length > 255)) throw new DimensionRefusal('an alias is at most 255 characters');
  const addAliases = target.filter((t) => !current.some((c) => c.key === t.key));
  const removeAliasKeys = current.filter((c) => !target.some((t) => t.key === c.key)).map((c) => c.key);
  for (const a of addAliases) {
    const clash = takenBy(a.key);
    if (clash) throw new DimensionRefusal(`alias "${a.alias}" is already the code or an alias of ${clash.code}`);
  }

  const description = cleanText(input.description, before.description);
  const department = cleanText(input.department, before.department);
  if (department && department.length > 100) throw new DimensionRefusal('department is at most 100 characters');
  const after = { code, name, parentId, parentCode, fnoCode, isActive, description, department };
  const changed = [
    code !== before.code ? 'code' : '', name !== before.name ? 'name' : '',
    parentId !== before.parentId ? 'parent' : '', isActive !== before.isActive ? 'is_active' : '',
    description !== before.description ? 'description' : '', department !== before.department ? 'department' : '',
    addAliases.length > 0 || removeAliasKeys.length > 0 ? 'aliases' : '',
  ].filter(Boolean);
  if (changed.length === 0) throw new DimensionRefusal('Nothing to change');
  return { before, after, addAliases, removeAliasKeys, changed, warnings };
}

/** Write the plan. Refuses nothing — call it with no catch. */
export async function applyUpdateDimensionCostCentre(
  companyId: string,
  plan: UpdateDimensionCostCentrePlan,
  userId: string,
): Promise<void> {
  const a = plan.after;
  await sql`
    UPDATE cost_centres SET
      code = ${a.code}, name = ${a.name}, parent_id = ${a.parentId}::UUID, is_active = ${a.isActive},
      description = ${a.description}, department = ${a.department}, updated_at = NOW()
    WHERE id = ${plan.before.id}::UUID AND company_id = ${companyId}::UUID
  `;
  if (plan.removeAliasKeys.length > 0) {
    await sql`
      DELETE FROM cost_centre_aliases
      WHERE company_id = ${companyId}::UUID AND cost_centre_id = ${plan.before.id}::UUID
        AND alias_normalized = ANY(${plan.removeAliasKeys}::TEXT[])
    `;
  }
  for (const al of plan.addAliases) {
    await sql`
      INSERT INTO cost_centre_aliases (company_id, cost_centre_id, alias, alias_normalized)
      VALUES (${companyId}::UUID, ${plan.before.id}::UUID, ${al.alias}, ${al.key})
    `;
  }
  log.info('Updated dimension cost centre', {
    companyId, id: plan.before.id, code: a.code, changed: plan.changed, userId,
  }, 'accounting');
}

/** The cost centre a delete would remove; refuses (counted) while anything uses it. */
export async function planDeleteDimensionCostCentre(companyId: string, ref: string): Promise<DimensionCostCentre> {
  const all = await listDimensionCostCentres(companyId, { includeInactive: true });
  const target = findDimensionCostCentre(all, ref);
  if (!target) throw new DimensionRefusal(`cost centre "${ref}" does not exist in this company`);
  await assertCostCentreUnused(companyId, target.id);
  return target;
}

/** Aliases go with it (ON DELETE CASCADE). */
export async function applyDeleteDimensionCostCentre(companyId: string, target: DimensionCostCentre, userId: string): Promise<void> {
  await deleteCostCentre(companyId, target.id);
  log.info('Deleted dimension cost centre', { companyId, id: target.id, code: target.code, userId }, 'accounting');
}
