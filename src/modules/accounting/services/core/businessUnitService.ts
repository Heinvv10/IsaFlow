/**
 * Business Unit Service
 * CRUD operations for the business_units table
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';


export interface BusinessUnit {
  id: string;
  code: string;
  name: string;
  description?: string;
  /** Organisation ladder L2 (migration 870). */
  division?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessUnitInput {
  code: string;
  name: string;
  description?: string;
  division?: string;
}

export async function getBusinessUnits(companyId: string, activeOnly = false): Promise<BusinessUnit[]> {
  const rows = activeOnly
    ? ((await sql`SELECT * FROM business_units WHERE company_id = ${companyId} AND is_active = true ORDER BY code`) as DbRow[])
    : ((await sql`SELECT * FROM business_units WHERE company_id = ${companyId} ORDER BY code`) as DbRow[]);
  return rows.map(mapRow);
}

export async function createBusinessUnit(companyId: string, input: BusinessUnitInput, _userId: string): Promise<BusinessUnit> {
  const rows = (await sql`
    INSERT INTO business_units (company_id, code, name, description, division)
    VALUES (${companyId}, ${input.code}, ${input.name}, ${input.description || null}, ${input.division || null})
    RETURNING *
  `) as Record<string, unknown>[];
  log.info('Created business unit', { id: rows[0]!.id, code: input.code }, 'accounting');
  return mapRow(rows[0]!);
}

/**
 * A refusal written for the operator (the action route and the MCP tools pass
 * its message through); anything else stays a generic failure.
 */
export class BusinessUnitActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessUnitActionError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A business unit by UUID or code (case-insensitive), active or not. */
export async function findBusinessUnit(companyId: string, ref: string): Promise<BusinessUnit> {
  const key = ref.trim();
  const rows = UUID_RE.test(key)
    ? ((await sql`SELECT * FROM business_units WHERE company_id = ${companyId} AND id = ${key}::UUID`) as DbRow[])
    : ((await sql`SELECT * FROM business_units WHERE company_id = ${companyId} AND lower(code) = ${key.toLowerCase()}`) as DbRow[]);
  if (!rows[0]) throw new BusinessUnitActionError(`Business unit not found: ${ref}`);
  return mapRow(rows[0]);
}

/**
 * undefined leaves a field as it is; null or '' clears description / division.
 * code and name can be changed but never cleared.
 */
export interface BusinessUnitUpdate {
  code?: string;
  name?: string;
  description?: string | null;
  division?: string | null;
  isActive?: boolean;
}

export interface BusinessUnitUpdatePlan {
  before: BusinessUnit;
  after: { code: string; name: string; description: string | null; division: string | null; isActive: boolean };
  changed: string[];
}

/** Every refusal, from reads only. */
export async function planUpdateBusinessUnit(companyId: string, ref: string, input: BusinessUnitUpdate): Promise<BusinessUnitUpdatePlan> {
  const before = await findBusinessUnit(companyId, ref);
  const code = input.code === undefined ? before.code : input.code.trim();
  const name = input.name === undefined ? before.name : input.name.trim();
  if (!code || code.length > 20) throw new BusinessUnitActionError('code is required and at most 20 characters');
  if (!name || name.length > 255) throw new BusinessUnitActionError('name is required and at most 255 characters');
  const clear = (v: string | null | undefined, old: string | undefined): string | null =>
    (v === undefined ? (old ?? null) : (v === null || !v.trim() ? null : v.trim()));
  const description = clear(input.description, before.description);
  const division = clear(input.division, before.division);
  if (division && division.length > 120) throw new BusinessUnitActionError('division is at most 120 characters');
  if (code.toLowerCase() !== before.code.toLowerCase()) {
    const taken = (await sql`
      SELECT code FROM business_units WHERE company_id = ${companyId} AND lower(code) = ${code.toLowerCase()} AND id <> ${before.id}::UUID
    `) as { code: string }[];
    if (taken[0]) throw new BusinessUnitActionError(`A business unit with code ${String(taken[0].code)} already exists`);
  }
  const after = { code, name, description, division, isActive: input.isActive ?? before.isActive };
  const changed = [
    after.code !== before.code ? 'code' : '', after.name !== before.name ? 'name' : '',
    after.description !== (before.description ?? null) ? 'description' : '',
    after.division !== (before.division ?? null) ? 'division' : '',
    after.isActive !== before.isActive ? 'is_active' : '',
  ].filter(Boolean);
  if (changed.length === 0) throw new BusinessUnitActionError('Nothing to change');
  return { before, after, changed };
}

export async function applyUpdateBusinessUnit(companyId: string, plan: BusinessUnitUpdatePlan): Promise<BusinessUnit> {
  const a = plan.after;
  const rows = (await sql`
    UPDATE business_units SET
      code = ${a.code}, name = ${a.name}, description = ${a.description}, division = ${a.division},
      is_active = ${a.isActive}, updated_at = NOW()
    WHERE id = ${plan.before.id}::UUID AND company_id = ${companyId} RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new BusinessUnitActionError(`Business unit not found: ${plan.before.id}`);
  log.info('Updated business unit', { id: plan.before.id, changed: plan.changed }, 'accounting');
  return mapRow(rows[0]);
}

export async function updateBusinessUnit(companyId: string, id: string, input: BusinessUnitUpdate): Promise<BusinessUnit> {
  return applyUpdateBusinessUnit(companyId, await planUpdateBusinessUnit(companyId, id, input));
}

export async function toggleBusinessUnit(companyId: string, id: string, isActive: boolean): Promise<void> {
  const result = (await sql`UPDATE business_units SET is_active = ${isActive}, updated_at = NOW() WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING id`) as Record<string, unknown>[];
  if (result.length === 0) throw new BusinessUnitActionError(`Business unit not found: ${id}`);
}

/**
 * Throws a counted refusal when anything still carries the BU. The document and
 * default columns (migration 870) have RESTRICT FKs; the journal, bank and
 * tag-history columns have none, so only this count protects them.
 */
export async function assertBusinessUnitUnused(companyId: string, id: string): Promise<void> {
  const [row] = (await sql`
    SELECT
      (SELECT COUNT(*) FROM gl_journal_lines jl
        WHERE jl.bu_id = ${id}::UUID AND jl.company_id = ${companyId}::UUID) AS journal_lines,
      (SELECT COUNT(*) FROM bank_transactions bt
        WHERE bt.bu_id = ${id}::UUID AND bt.company_id = ${companyId}::UUID) AS bank_transactions,
      (
        (SELECT COUNT(*) FROM supplier_invoice_items sii
          JOIN supplier_invoices sip ON sip.id = sii.supplier_invoice_id
          WHERE sii.bu_id = ${id}::UUID AND sip.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM customer_invoice_items cii
          JOIN customer_invoices cip ON cip.id = cii.invoice_id
          WHERE cii.bu_id = ${id}::UUID AND cip.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM credit_notes cn
          WHERE cn.bu_id = ${id}::UUID AND cn.company_id = ${companyId}::UUID)
      ) AS documents,
      (SELECT COUNT(*) FROM gl_accounts ga
        WHERE ga.default_bu_id = ${id}::UUID AND ga.company_id = ${companyId}::UUID) AS defaults,
      (SELECT COUNT(*) FROM dimension_tag_batch_lines tl
        JOIN dimension_tag_batches tb ON tb.id = tl.batch_id
        WHERE tl.old_bu_id = ${id}::UUID AND tb.reversed_at IS NULL
          AND tb.company_id = ${companyId}::UUID) AS tag_history
  `) as Record<string, unknown>[];
  const labels: [string, string][] = [
    ['journal_lines', 'journal line(s)'], ['bank_transactions', 'bank transaction(s)'],
    ['documents', 'document line(s)'], ['defaults', 'account default(s)'],
    ['tag_history', 'un-reversed tag batch line(s)'],
  ];
  const used = labels
    .map(([key, label]) => [Number(row?.[key] ?? 0), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (used.length > 0) {
    throw new BusinessUnitActionError(`Cannot delete business unit that is used by ${used.join(', ')}. Deactivate instead.`);
  }
}

export async function deleteBusinessUnit(companyId: string, id: string): Promise<void> {
  await assertBusinessUnitUnused(companyId, id);
  let deleted: Record<string, unknown>[];
  try {
    deleted = (await sql`DELETE FROM business_units WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING id`) as Record<string, unknown>[];
  } catch (err) {
    // The count is tenant-scoped, the RESTRICT FKs are not.
    if ((err as { code?: string }).code === '23503') {
      throw new BusinessUnitActionError('Cannot delete business unit that is used by other records. Deactivate instead.');
    }
    throw err;
  }
  if (deleted.length === 0) throw new BusinessUnitActionError(`Business unit not found: ${id}`);
}

function mapRow(row: Record<string, unknown>): BusinessUnit {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    division: row.division ? String(row.division) : undefined,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
