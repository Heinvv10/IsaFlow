/**
 * The CC1 / CC2 master as the dimension model reads it: each cost centre with
 * its parent, its derived FNO and its aliases — and the one create path that
 * keeps the project ladder well-formed (brief §5.2 "strictly one parent per
 * child"; §5.3 project master + alias table).
 *
 * Ladder rules enforced on create:
 *   - a CC1 (FNO) is the top of the project ladder: it takes no parent;
 *   - a CC2's parent is a CC1, or a CC2 programme whose chain reaches a CC1;
 *   - an alias is unique per company (normalised) and may not shadow another
 *     cost centre's code — an alias that could mean two things means neither.
 *
 * Every refusal is a DimensionRefusal raised from reads, before the first write.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { aliasKey, resolveDimensionRefs } from './dimensionRefResolver';
import { deriveFnoId, type CostCentreNode } from './dimensionDerivation';
import { DimensionRefusal, isDimensionRefusal } from './dimensionTypes';

/** A reference that names nothing in this slot is a miss; anything else (a driver error) propagates. */
function missAsNull(err: unknown): null {
  if (isDimensionRefusal(err)) return null;
  throw err;
}

export type DimensionCcType = 'cc1' | 'cc2';

export interface DimensionCostCentre {
  id: string;
  code: string;
  name: string;
  ccType: string;
  isActive: boolean;
  parentId: string | null;
  parentCode: string | null;
  /** The FNO (CC1) code a CC2 rolls up to; the row's own code for a CC1. */
  fnoCode: string | null;
  aliases: string[];
  description: string | null;
  department: string | null;
}

interface CcRow {
  id: string; code: string; name: string; cc_type: string | null; is_active: boolean | null;
  parent_id: string | null; parent_code: string | null; aliases: string[] | null;
  description: string | null; department: string | null;
}

export async function listDimensionCostCentres(
  companyId: string,
  opts: { ccType?: DimensionCcType; includeInactive?: boolean } = {},
): Promise<DimensionCostCentre[]> {
  const rows = (await sql`
    SELECT cc.id::TEXT AS id, cc.code, cc.name, cc.cc_type, cc.is_active, cc.description, cc.department,
           cc.parent_id::TEXT AS parent_id, p.code AS parent_code,
           COALESCE((SELECT array_agg(a.alias ORDER BY a.alias) FROM cost_centre_aliases a
                      WHERE a.cost_centre_id = cc.id AND a.company_id = cc.company_id), '{}') AS aliases
    FROM cost_centres cc
    LEFT JOIN cost_centres p ON p.id = cc.parent_id AND p.company_id = cc.company_id
    WHERE cc.company_id = ${companyId}::UUID
    ORDER BY cc.cc_type, cc.code
  `) as CcRow[];
  const nodes = new Map<string, CostCentreNode>(rows.map((r) => [r.id, {
    id: r.id, code: String(r.code), parentId: r.parent_id, ccType: r.cc_type,
  }]));
  return rows
    .filter((r) => (opts.ccType ? r.cc_type === opts.ccType : true))
    .filter((r) => opts.includeInactive || r.is_active === true)
    .map((r) => {
      const fnoId = r.cc_type === 'cc1' ? r.id : deriveFnoId(r.id, nodes);
      return {
        id: r.id, code: String(r.code), name: String(r.name), ccType: String(r.cc_type ?? 'cc1'),
        isActive: r.is_active === true, parentId: r.parent_id, parentCode: r.parent_code ?? null,
        fnoCode: fnoId ? (nodes.get(fnoId)?.code ?? null) : null, aliases: r.aliases ?? [],
        description: r.description ?? null, department: r.department ?? null,
      };
    });
}

export interface CreateDimensionCostCentreInput {
  code: string;
  name: string;
  ccType: DimensionCcType;
  /** Parent code, UUID or alias. CC2 only. */
  parent?: string;
  aliases?: string[];
  description?: string;
  department?: string;
}

export interface CreateDimensionCostCentrePlan {
  input: CreateDimensionCostCentreInput;
  parentId: string | null;
  fnoCode: string | null;
  aliases: { alias: string; key: string }[];
  warnings: string[];
}

/** Every refusal, from reads only. */
export async function planCreateDimensionCostCentre(
  companyId: string,
  input: CreateDimensionCostCentreInput,
): Promise<CreateDimensionCostCentrePlan> {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code || code.length > 20) throw new DimensionRefusal('code is required and at most 20 characters');
  if (!name || name.length > 255) throw new DimensionRefusal('name is required and at most 255 characters');
  if (input.department && input.department.trim().length > 100) throw new DimensionRefusal('department is at most 100 characters');
  if (input.ccType === 'cc1' && input.parent) {
    throw new DimensionRefusal('A CC1 (FNO) is the top of the project ladder and takes no parent');
  }
  const taken = (await sql`
    SELECT code FROM cost_centres WHERE company_id = ${companyId}::UUID AND lower(code) = ${code.toLowerCase()}
  `) as { code: string }[];
  if (taken.length > 0) throw new DimensionRefusal(`A cost centre with code ${String(taken[0]!.code)} already exists`);

  let parentId: string | null = null;
  let fnoCode: string | null = input.ccType === 'cc1' ? code : null;
  const warnings: string[] = [];
  if (input.ccType === 'cc2') {
    if (input.parent) {
      // A parent may be a CC1 or a programme CC2: try both slots, CC1 first.
      const asCc1 = await resolveDimensionRefs(companyId, [{ cc1: input.parent }], () => 'parent')
        .then((r) => r[0]?.cc1Id ?? null).catch(missAsNull);
      const asCc2 = asCc1 ? null : await resolveDimensionRefs(companyId, [{ cc2: input.parent }], () => 'parent')
        .then((r) => r[0]?.cc2Id ?? null).catch(missAsNull);
      parentId = asCc1 ?? asCc2;
      if (!parentId) throw new DimensionRefusal(`parent "${input.parent}" does not name an active CC1 or CC2 in this company`);
      const listed = await listDimensionCostCentres(companyId, { includeInactive: true });
      const parent = listed.find((c) => c.id === parentId);
      fnoCode = parent?.fnoCode ?? null;
      if (!fnoCode) {
        throw new DimensionRefusal(`parent "${input.parent}" is a CC2 whose chain reaches no CC1 (FNO) — fix the programme first`);
      }
    } else {
      warnings.push(`CC2 ${code} has no parent, so no FNO can be derived for it; set a CC1 or programme parent.`);
    }
  }

  const aliases = [...new Map((input.aliases ?? [])
    .map((a) => a.trim()).filter(Boolean).map((a) => [aliasKey(a), a])).entries()]
    .map(([key, alias]) => ({ alias, key }));
  if (aliases.some((a) => a.key.length > 255)) throw new DimensionRefusal('an alias is at most 255 characters');
  if (aliases.length > 0) {
    const keys = aliases.map((a) => a.key);
    const clash = (await sql`
      SELECT a.alias AS text FROM cost_centre_aliases a
      WHERE a.company_id = ${companyId}::UUID AND a.alias_normalized = ANY(${keys}::TEXT[])
      UNION ALL
      SELECT c.code AS text FROM cost_centres c
      WHERE c.company_id = ${companyId}::UUID AND lower(c.code) = ANY(${keys}::TEXT[])
      LIMIT 1
    `) as { text: string }[];
    if (clash.length > 0) {
      throw new DimensionRefusal(`alias "${String(clash[0]!.text)}" is already an alias or code of another cost centre`);
    }
  }
  return { input: { ...input, code, name }, parentId, fnoCode, aliases, warnings };
}

/** Write the plan. Refuses nothing — call it with no catch. */
export async function applyCreateDimensionCostCentre(
  companyId: string,
  plan: CreateDimensionCostCentrePlan,
  userId: string,
): Promise<{ id: string }> {
  const [row] = (await sql`
    INSERT INTO cost_centres (company_id, code, name, cc_type, parent_id, description, department)
    VALUES (${companyId}::UUID, ${plan.input.code}, ${plan.input.name}, ${plan.input.ccType}, ${plan.parentId}::UUID,
            ${plan.input.description?.trim() || null}, ${plan.input.department?.trim() || null})
    RETURNING id::TEXT AS id
  `) as { id: string }[];
  for (const a of plan.aliases) {
    await sql`
      INSERT INTO cost_centre_aliases (company_id, cost_centre_id, alias, alias_normalized)
      VALUES (${companyId}::UUID, ${row!.id}::UUID, ${a.alias}, ${a.key})
    `;
  }
  log.info('Created dimension cost centre', {
    companyId, id: row!.id, code: plan.input.code, ccType: plan.input.ccType, userId,
  }, 'accounting');
  return { id: row!.id };
}
