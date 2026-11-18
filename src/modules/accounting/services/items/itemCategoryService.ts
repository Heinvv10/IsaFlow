/**
 * Item categories for the MCP tools: `list_item_categories` and `upsert_item_category`.
 *
 * Matching for an upsert: the external reference first, then the code, then (when the row names neither) the name,
 * case-insensitively. A name, code or reference that belongs to a DIFFERENT category than the one matched is refused;
 * nothing is created under a clashing key. Like the item tools it cannot clear a field. Every statement names
 * `company_id`; `plan…` reads, `apply…` writes, and a dry run is the plan alone.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { mapCategoryRow, type CatalogCategory } from './itemCatalogTypes';
import { ITEM_CODE_SEED, takeCompanyNumberLock } from '../core/numberLock';

export interface CategoryInput {
  name: string;
  code?: string;
  description?: string;
  isActive?: boolean;
  externalSystem?: string;
  externalRef?: string;
}

export type CategoryCheck = { ok: true; input: CategoryInput } | { ok: false; reason: string };

const CATEGORY_KEYS = ['name', 'code', 'description', 'is_active', 'external_system', 'external_ref'];

export function validateCategoryInput(raw: Record<string, unknown>): CategoryCheck {
  const text = (key: string, max: number): string | undefined | false => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !v.trim() || v.trim().length > max) return false;
    return v.trim();
  };
  const name = text('name', 255);
  const code = text('code', 50);
  const description = text('description', 1000);
  const system = text('external_system', 32);
  const ref = text('external_ref', 128);
  if (name === undefined || name === false) return { ok: false, reason: 'name is required (at most 255 characters)' };
  for (const [key, v, max] of [['code', code, 50], ['description', description, 1000], ['external_system', system, 32], ['external_ref', ref, 128]] as const) {
    if (v === false) return { ok: false, reason: `${key} must be a non-empty string of at most ${max} characters` };
  }
  if (raw.is_active !== undefined && typeof raw.is_active !== 'boolean') return { ok: false, reason: 'is_active must be true or false' };
  if (ref && !system) return { ok: false, reason: 'external_system is required with external_ref (e.g. "sage")' };
  const unknown = Object.keys(raw).find((k) => !CATEGORY_KEYS.includes(k));
  if (unknown) return { ok: false, reason: `${unknown} is not a category field` };
  return {
    ok: true,
    input: {
      name, code: code || undefined, description: description || undefined, isActive: raw.is_active as boolean | undefined,
      externalSystem: system ? system.toLowerCase() : undefined, externalRef: ref || undefined,
    },
  };
}

export async function listItemCategories(
  companyId: string, opts: { includeInactive: boolean; q?: string | null },
): Promise<CatalogCategory[]> {
  const term = opts.q ? `%${opts.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const rows = (await sql`
    SELECT c.*, (SELECT COUNT(*)::INT FROM items i
                 WHERE i.company_id = c.company_id AND i.category_id = c.id AND i.deleted_at IS NULL) AS item_count
    FROM item_categories c
    WHERE c.company_id = ${companyId}::UUID
      AND (${opts.includeInactive}::BOOLEAN OR c.is_active)
      AND (${term}::TEXT IS NULL OR c.name ILIKE ${term}::TEXT OR c.code ILIKE ${term}::TEXT)
    ORDER BY c.name ASC, c.id ASC
  `) as DbRow[];
  return rows.map(mapCategoryRow);
}

export type CategoryPlan =
  | { refusal: { code: string; reason: string } }
  | { outcome: 'created' | 'updated' | 'unchanged'; id: string | null; changed: string[]; input: CategoryInput };

const refuse = (code: string, reason: string): CategoryPlan => ({ refusal: { code, reason } });

export async function planCategoryUpsert(companyId: string, input: CategoryInput): Promise<CategoryPlan> {
  await takeCompanyNumberLock(companyId, 'item_categories_upsert', ITEM_CODE_SEED); // bounded (migration 864): 5 s, then 55P03
  const rows = (await sql`
    SELECT * FROM item_categories WHERE company_id = ${companyId}::UUID
      AND (LOWER(name) = LOWER(${input.name}) OR (${input.code ?? null}::TEXT IS NOT NULL AND code = ${input.code ?? null}::TEXT)
           OR (${input.externalRef ?? null}::TEXT IS NOT NULL AND external_system = ${input.externalSystem ?? null}::TEXT
               AND external_ref = ${input.externalRef ?? null}::TEXT))
  `) as DbRow[];
  const byRef = input.externalRef ? rows.find((r) => r.external_system === input.externalSystem && r.external_ref === input.externalRef) : undefined;
  const byCode = input.code ? rows.find((r) => r.code === input.code) : undefined;
  const byName = rows.filter((r) => String(r.name).toLowerCase() === input.name.toLowerCase());
  if (byRef && byCode && byRef.id !== byCode.id) return refuse('ref_code_conflict', 'that external_ref and that code belong to two different categories');

  const match = byRef ?? byCode ?? (input.code || input.externalRef ? undefined : byName[0]);
  const nameClash = byName.find((r) => !match || r.id !== match.id);
  if (nameClash) return refuse('name_in_use', `the name ${input.name} belongs to another category`);
  if (!match) {
    const given: Array<[string, unknown]> = [
      ['name', input.name], ['code', input.code], ['description', input.description], ['is_active', input.isActive],
      ['external_system', input.externalSystem], ['external_ref', input.externalRef],
    ];
    return { outcome: 'created', id: null, changed: given.filter(([, v]) => v !== undefined).map(([k]) => k), input };
  }
  if (byCode && !byRef && input.externalRef && match.external_ref && (match.external_system !== input.externalSystem || match.external_ref !== input.externalRef)) {
    return refuse('code_in_use_by_other_ref', 'that code belongs to a category with a different external reference');
  }
  const checks: Array<[string, unknown, unknown]> = [
    ['name', input.name, match.name], ['code', input.code, match.code], ['description', input.description, match.description],
    ['is_active', input.isActive, match.is_active], ['external_system', input.externalSystem, match.external_system],
    ['external_ref', input.externalRef, match.external_ref],
  ];
  const changed = checks.filter(([, next, old]) => next !== undefined && next !== old).map(([k]) => k);
  return { outcome: changed.length === 0 ? 'unchanged' : 'updated', id: String(match.id), changed, input };
}

export async function applyCategoryPlan(
  companyId: string, plan: Extract<CategoryPlan, { outcome: string }>,
): Promise<string> {
  const i = plan.input;
  if (plan.outcome === 'created') {
    const inserted = (await sql`
      INSERT INTO item_categories (company_id, name, code, description, is_active, external_system, external_ref)
      VALUES (${companyId}::UUID, ${i.name}, ${i.code ?? null}, ${i.description ?? null}, ${i.isActive ?? true},
              ${i.externalSystem ?? null}, ${i.externalRef ?? null})
      RETURNING id
    `) as DbRow[];
    return String(inserted[0]!.id);
  }
  if (plan.outcome === 'updated') {
    if (!plan.id || !UUID_RE.test(plan.id)) throw new Error('item_categories: no id to update');
    const updated = (await sql`
      UPDATE item_categories SET
        name = ${i.name}, code = COALESCE(${i.code ?? null}, code), description = COALESCE(${i.description ?? null}, description),
        is_active = COALESCE(${i.isActive ?? null}::BOOLEAN, is_active),
        external_system = COALESCE(${i.externalSystem ?? null}, external_system),
        external_ref = COALESCE(${i.externalRef ?? null}, external_ref), updated_at = NOW()
      WHERE id = ${plan.id}::UUID AND company_id = ${companyId}::UUID RETURNING id
    `) as DbRow[];
    if (updated.length !== 1) throw new Error('item_categories: the category matched nothing when it was written');
  }
  return plan.id as string;
}
