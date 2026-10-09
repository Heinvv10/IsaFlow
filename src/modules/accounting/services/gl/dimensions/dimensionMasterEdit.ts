/**
 * Edit and delete for the CC1 / CC2 master, under the same ladder rules the
 * create path enforces (dimensionMasterService):
 *   - a CC1 takes no parent; a CC2's parent is an active CC1, or an active
 *     programme CC2 whose chain reaches a CC1 — and never itself or a descendant;
 *   - a code or alias may not equal another cost centre's code or alias;
 *   - a node with active children, or that a customer / account / coding rule
 *     names as its default, cannot be deactivated, and a node under an
 *     inactive parent cannot be reactivated;
 *   - a parent left as it is is kept as it is, active or not.
 *
 * Moving a CC2 (or a programme, with its subtree) under another FNO is refused
 * while anything carries it: every tagged line, document and default stored the
 * CC1 derived when it was written, so the move would leave that CC1 wrong. Re-tag
 * first, then move.
 *
 * Every refusal is a DimensionRefusal raised from reads, before the first write.
 * Every plan first takes the company's master lock (dimensionMasterLock), so two
 * concurrent edits cannot each plan against the master as it was before the other.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertCostCentreUnused, costCentreDefaultUsage, countCc2Carriers } from '../../core/costCentreUsageGuard';
import { deleteCostCentre } from '../../core/costCentreService';
import { lockDimensionMasters } from '../../core/dimensionMasterLock';
import { listDimensionCostCentres, type DimensionCcType, type DimensionCostCentre } from './dimensionMasterService';
import { aliasKey } from './dimensionRefResolver';
import { DimensionRefusal } from './dimensionTypes';

/**
 * By UUID, code (any case) or alias — active or not, narrowed to one cc_type when
 * the caller names it. Codes are unique only as typed, so a code that matches
 * more than one centre ignoring case (a CC1 "ABC" beside a CC2 "abc", or two
 * case variants of one type) names none of them, and is refused even when one
 * of them matches exactly: the caller sends the id, or the cc_type.
 */
export function findDimensionCostCentre(
  all: DimensionCostCentre[], ref: string, ccType?: DimensionCcType,
): DimensionCostCentre | undefined {
  const text = ref.trim();
  const byId = all.find((c) => c.id === text.toLowerCase());
  if (byId) return byId;
  const pool = ccType ? all.filter((c) => c.ccType === ccType) : all;
  const byCode = pool.filter((c) => c.code.toLowerCase() === text.toLowerCase());
  if (byCode.length > 1) {
    throw new DimensionRefusal(
      `"${ref}" matches ${byCode.length} cost centres (${byCode.map((c) => `${c.code} ${c.ccType}`).join(', ')}) — `
      + 'send its id, or its cc_type',
    );
  }
  const key = aliasKey(ref);
  return byCode[0] ?? pool.find((c) => c.aliases.some((a) => aliasKey(a) === key));
}

const UNIQUE_VIOLATION = '23505';

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
  notes?: string | null;
  isActive?: boolean;
}

export interface UpdateDimensionCostCentrePlan {
  before: DimensionCostCentre;
  after: {
    code: string; name: string; parentId: string | null; parentCode: string | null; fnoCode: string | null;
    isActive: boolean; description: string | null; department: string | null; notes: string | null;
  };
  addAliases: { alias: string; key: string }[];
  removeAliasKeys: string[];
  /** Empty when the input changes nothing; the caller decides whether that is a refusal. */
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
  refCcType?: DimensionCcType,
): Promise<UpdateDimensionCostCentrePlan> {
  await lockDimensionMasters(companyId);
  const all = await listDimensionCostCentres(companyId, { includeInactive: true });
  const before = findDimensionCostCentre(all, ref, refCcType);
  if (!before) throw new DimensionRefusal(`cost centre "${ref}" does not exist in this company`);
  const others = all.filter((c) => c.id !== before.id);
  const takenBy = (key: string) => others.find((c) => c.code.toLowerCase() === key || c.aliases.some((a) => aliasKey(a) === key));

  const code = input.code === undefined ? before.code : input.code.trim();
  const name = input.name === undefined ? before.name : input.name.trim();
  if (!code || code.length > 20) throw new DimensionRefusal('code is required and at most 20 characters');
  if (!name || name.length > 255) throw new DimensionRefusal('name is required and at most 255 characters');
  // Exact, not folded: a case-only rename onto another code must be refused too.
  if (code !== before.code) {
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
      // The form re-sends the parent it was given: that one is kept as it is,
      // even inactive or with no FNO above it. Only a NEW parent is checked.
      if (!parent || parent.id !== before.parentId) {
        if (!parent || !parent.isActive) throw new DimensionRefusal(`parent "${input.parent}" does not name an active CC1 or CC2 in this company`);
        if (parent.id === before.id || descendantsOf(all, before.id).includes(parent.id)) {
          throw new DimensionRefusal(`parent "${input.parent}" is ${before.code} itself or below it — that would make a loop`);
        }
        if (!parent.fnoCode) throw new DimensionRefusal(`parent "${input.parent}" is a CC2 whose chain reaches no CC1 (FNO) — fix the programme first`);
        parentId = parent.id; parentCode = parent.code; fnoCode = parent.fnoCode;
      }
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
    const defaults = await costCentreDefaultUsage(companyId, before.id);
    if (defaults) throw new DimensionRefusal(`${before.code} is the default on ${defaults} — clear those defaults before deactivating it`);
  }
  if (isActive && !before.isActive && parentId) {
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
  const notes = cleanText(input.notes, before.notes);
  const after = { code, name, parentId, parentCode, fnoCode, isActive, description, department, notes };
  const changed = [
    code !== before.code ? 'code' : '', name !== before.name ? 'name' : '',
    parentId !== before.parentId ? 'parent' : '', isActive !== before.isActive ? 'is_active' : '',
    description !== before.description ? 'description' : '', department !== before.department ? 'department' : '',
    notes !== before.notes ? 'notes' : '', addAliases.length > 0 || removeAliasKeys.length > 0 ? 'aliases' : '',
  ].filter(Boolean);
  return { before, after, addAliases, removeAliasKeys, changed, warnings };
}

/**
 * Write the plan (nothing, when it changes nothing). Its writes run in one
 * savepoint: a code or alias taken by a writer outside the master lock (23505)
 * rolls them all back and comes out as a DimensionRefusal, so a caller that
 * answers the refusal leaves nothing half-written behind.
 */
export async function applyUpdateDimensionCostCentre(
  companyId: string,
  plan: UpdateDimensionCostCentrePlan,
  userId: string,
): Promise<void> {
  if (plan.changed.length === 0) return;
  const a = plan.after;
  try {
    await withSavepoint('cost_centre_update', async () => {
      await sql`
        UPDATE cost_centres SET
          code = ${a.code}, name = ${a.name}, parent_id = ${a.parentId}::UUID, is_active = ${a.isActive},
          description = ${a.description}, department = ${a.department}, notes = ${a.notes}, updated_at = NOW()
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
    });
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new DimensionRefusal(`code ${a.code} or one of its aliases was just taken by another cost centre — reload and try again`);
    }
    throw err;
  }
  log.info('Updated dimension cost centre', {
    companyId, id: plan.before.id, code: a.code, changed: plan.changed, userId,
  }, 'accounting');
}

/** The cost centre a delete would remove; refuses (counted) while anything uses it. */
export async function planDeleteDimensionCostCentre(
  companyId: string, ref: string, refCcType?: DimensionCcType,
): Promise<DimensionCostCentre> {
  await lockDimensionMasters(companyId);
  const all = await listDimensionCostCentres(companyId, { includeInactive: true });
  const target = findDimensionCostCentre(all, ref, refCcType);
  if (!target) throw new DimensionRefusal(`cost centre "${ref}" does not exist in this company`);
  await assertCostCentreUnused(companyId, target.id);
  return target;
}

/** Aliases go with it (ON DELETE CASCADE). */
export async function applyDeleteDimensionCostCentre(companyId: string, target: DimensionCostCentre, userId: string): Promise<void> {
  await deleteCostCentre(companyId, target.id);
  log.info('Deleted dimension cost centre', { companyId, id: target.id, code: target.code, userId }, 'accounting');
}
