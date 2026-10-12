/**
 * Business Unit Service
 * CRUD operations for the business_units table. Every write plans from reads
 * (refusals are BusinessUnitActionError, raised before the first write) under
 * the company's dimension-master lock.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { countedParts } from './costCentreUsageGuard';
import { lockDimensionMasters } from './dimensionMasterLock';


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
const UNIQUE_VIOLATION = '23505';

/** Another BU's code equal to `code` ignoring case, or undefined. */
async function codeTakenBy(companyId: string, code: string, exceptId: string | null): Promise<string | undefined> {
  const taken = (await sql`
    SELECT code FROM business_units
    WHERE company_id = ${companyId} AND lower(code) = ${code.toLowerCase()} AND id IS DISTINCT FROM ${exceptId}::UUID
  `) as { code: string }[];
  return taken[0] ? String(taken[0].code) : undefined;
}

/** Trimmed and checked; refuses a bad length or a code another BU has (ignoring case). */
export async function planCreateBusinessUnit(companyId: string, input: BusinessUnitInput): Promise<BusinessUnitInput> {
  await lockDimensionMasters(companyId);
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code || code.length > 20) throw new BusinessUnitActionError('code is required and at most 20 characters');
  if (!name || name.length > 255) throw new BusinessUnitActionError('name is required and at most 255 characters');
  const division = input.division?.trim() || undefined;
  if (division && division.length > 120) throw new BusinessUnitActionError('division is at most 120 characters');
  const taken = await codeTakenBy(companyId, code, null);
  if (taken) throw new BusinessUnitActionError(`A business unit with code ${taken} already exists`);
  return { code, name, description: input.description?.trim() || undefined, division };
}

export async function applyCreateBusinessUnit(companyId: string, plan: BusinessUnitInput): Promise<BusinessUnit> {
  const rows = (await sql`
    INSERT INTO business_units (company_id, code, name, description, division)
    VALUES (${companyId}, ${plan.code}, ${plan.name}, ${plan.description ?? null}, ${plan.division ?? null})
    RETURNING *
  `) as Record<string, unknown>[];
  log.info('Created business unit', { id: rows[0]!.id, code: plan.code }, 'accounting');
  return mapRow(rows[0]!);
}

export async function createBusinessUnit(companyId: string, input: BusinessUnitInput): Promise<BusinessUnit> {
  return applyCreateBusinessUnit(companyId, await planCreateBusinessUnit(companyId, input));
}

/**
 * A business unit by UUID or code (any case), active or not. Codes are unique
 * only as typed, so a code that matches two business units ignoring case names
 * neither — even when one matches exactly — and is refused: send the id.
 */
export async function findBusinessUnit(companyId: string, ref: string): Promise<BusinessUnit> {
  const key = ref.trim();
  const rows = UUID_RE.test(key)
    ? ((await sql`SELECT * FROM business_units WHERE company_id = ${companyId} AND id = ${key}::UUID`) as DbRow[])
    : ((await sql`SELECT * FROM business_units WHERE company_id = ${companyId} AND lower(code) = ${key.toLowerCase()} ORDER BY code`) as DbRow[]);
  if (rows.length > 1) {
    throw new BusinessUnitActionError(`"${ref}" matches ${rows.length} business units (${rows.map((r) => String(r.code)).join(', ')}) — send its id`);
  }
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
  /** Empty when the input changes nothing; the caller decides whether that is a refusal. */
  changed: string[];
}

/** Every refusal, from reads only. */
export async function planUpdateBusinessUnit(companyId: string, ref: string, input: BusinessUnitUpdate): Promise<BusinessUnitUpdatePlan> {
  await lockDimensionMasters(companyId);
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
  // Exact, not folded: a case-only rename onto another code must be refused too.
  if (code !== before.code) {
    const taken = await codeTakenBy(companyId, code, before.id);
    if (taken) throw new BusinessUnitActionError(`A business unit with code ${taken} already exists`);
  }
  const after = { code, name, description, division, isActive: input.isActive ?? before.isActive };
  if (!after.isActive && before.isActive) {
    const [row] = (await sql`
      SELECT COUNT(*) AS accounts FROM gl_accounts
      WHERE default_bu_id = ${before.id}::UUID AND company_id = ${companyId}::UUID
    `) as Record<string, unknown>[];
    const defaults = countedParts(row, [['accounts', 'account(s)']]);
    if (defaults) throw new BusinessUnitActionError(`${before.code} is the default on ${defaults} — clear those defaults before deactivating it`);
  }
  const changed = [
    after.code !== before.code ? 'code' : '', after.name !== before.name ? 'name' : '',
    after.description !== (before.description ?? null) ? 'description' : '',
    after.division !== (before.division ?? null) ? 'division' : '',
    after.isActive !== before.isActive ? 'is_active' : '',
  ].filter(Boolean);
  return { before, after, changed };
}

/**
 * Write the plan (nothing, when it changes nothing). The UPDATE runs in its own
 * savepoint, so a 23505 from a writer outside the master lock leaves the
 * request transaction usable and comes out as a refusal.
 */
export async function applyUpdateBusinessUnit(companyId: string, plan: BusinessUnitUpdatePlan): Promise<BusinessUnit> {
  if (plan.changed.length === 0) return plan.before;
  const a = plan.after;
  let rows: Record<string, unknown>[];
  try {
    rows = await withSavepoint('business_unit_update', async () => (await sql`
      UPDATE business_units SET
        code = ${a.code}, name = ${a.name}, description = ${a.description}, division = ${a.division},
        is_active = ${a.isActive}, updated_at = NOW()
      WHERE id = ${plan.before.id}::UUID AND company_id = ${companyId} RETURNING *
    `) as Record<string, unknown>[]);
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new BusinessUnitActionError(`A business unit with code ${a.code} already exists`);
    throw err;
  }
  if (!rows[0]) throw new BusinessUnitActionError(`Business unit not found: ${plan.before.id}`);
  log.info('Updated business unit', { id: plan.before.id, changed: plan.changed }, 'accounting');
  return mapRow(rows[0]);
}

/**
 * Throws a counted refusal when anything still carries the BU. The document and
 * default columns (migration 870) and the bank and journal columns (878 / 882, NOT
 * VALID) have RESTRICT FKs; the tag-history columns have none, so only this
 * count protects them.
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
          AND tb.company_id = ${companyId}::UUID) AS tag_history,
      (SELECT COUNT(*) FROM dimension_tag_batch_bank_rows br
        JOIN dimension_tag_batches tb ON tb.id = br.batch_id
        WHERE br.old_bu_id = ${id}::UUID AND tb.reversed_at IS NULL
          AND tb.company_id = ${companyId}::UUID AND br.company_id = ${companyId}::UUID) AS tag_bank_history
  `) as Record<string, unknown>[];
  const labels: [string, string][] = [
    ['journal_lines', 'journal line(s)'], ['bank_transactions', 'bank transaction(s)'],
    ['documents', 'document line(s)'], ['defaults', 'account default(s)'],
    ['tag_history', 'un-reversed tag batch line(s)'],
    ['tag_bank_history', 'un-reversed tag batch bank row(s)'],
  ];
  const used = labels
    .map(([key, label]) => [Number(row?.[key] ?? 0), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (used.length > 0) {
    throw new BusinessUnitActionError(`Cannot delete business unit that is used by ${used.join(', ')}. Deactivate instead.`);
  }
}

/** The BU a delete would remove; refuses (counted) while anything carries it. */
export async function planDeleteBusinessUnit(companyId: string, ref: string): Promise<BusinessUnit> {
  await lockDimensionMasters(companyId);
  const bu = await findBusinessUnit(companyId, ref);
  await assertBusinessUnitUnused(companyId, bu.id);
  return bu;
}

export async function deleteBusinessUnit(companyId: string, id: string): Promise<void> {
  await lockDimensionMasters(companyId);
  await assertBusinessUnitUnused(companyId, id);
  let deleted: Record<string, unknown>[];
  try {
    // Its own savepoint: a 23503 would otherwise abort the request transaction.
    deleted = await withSavepoint('business_unit_delete', async () =>
      (await sql`DELETE FROM business_units WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING id`) as Record<string, unknown>[]);
  } catch (err) {
    // The count is tenant-scoped, the RESTRICT FKs are not (and since migration
    // 878 / 882 they also hold a journal or bank line written after the count).
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
