/**
 * Budget versions (migration 947): list, get, create, copy, set primary, delete. Every write is one
 * audit row (entity 'budget', the version id). Status moves are budgetVersionStatus.ts; the
 * database audits those itself.
 *
 * Rules (decisions 1, 3, 13): a new version is a draft; one 'original' per company and year; a copy
 * stays in its source's year; the primary of a year can change at any status (the readers follow
 * it); a version is deleted only when it is neither primary nor locked, and an approved one only
 * by an owner or admin.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow, type AuditAction } from '../core/auditTrailService';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { getFiscalYear } from '../gl/fiscalYearRegistry';
import {
  BUDGET_VERSION_KINDS, BudgetVersionError, mapVersion, type BudgetVersion, type BudgetVersionKind,
} from './budgetVersionTypes';

export interface VersionActor { userId: string; role: string }

const APPROVERS = new Set(['owner', 'admin']);

/** A name and kind from a request, refused with BUDGET_VERSION_INPUT. */
export function parseVersionInput(name: unknown, kind: unknown): { name: string; kind: BudgetVersionKind } {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || trimmed.length > 120) throw new BudgetVersionError('BUDGET_VERSION_INPUT', 'name must be 1-120 characters');
  if (typeof kind !== 'string' || !(BUDGET_VERSION_KINDS as readonly string[]).includes(kind)) {
    throw new BudgetVersionError('BUDGET_VERSION_INPUT', `kind must be one of ${BUDGET_VERSION_KINDS.join(', ')}`);
  }
  return { name: trimmed, kind: kind as BudgetVersionKind };
}

export async function listVersions(companyId: string, fiscalYear?: number): Promise<BudgetVersion[]> {
  const rows = (await sql`
    SELECT v.*,
           to_char(v.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS approved_at_text,
           to_char(v.locked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS locked_at_text,
           to_char(v.unlocked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS unlocked_at_text,
           to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
           to_char(v.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text,
           COALESCE(a.n, 0) AS amount_count, COALESCE(a.total, 0) AS total
      FROM budget_versions v
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n, SUM(bm.amount)::numeric AS total FROM budget_month_amounts bm
         WHERE bm.company_id = v.company_id AND bm.version_id = v.id
      ) a ON true
     WHERE v.company_id = ${companyId}::UUID AND (${fiscalYear ?? null}::INT IS NULL OR v.fiscal_year = ${fiscalYear ?? null}::INT)
     ORDER BY v.fiscal_year DESC, v.is_primary DESC, v.created_at, v.id
  `) as DbRow[];
  return rows.map(mapVersion);
}

/** One version of the company; another company's id is BUDGET_VERSION_NOT_FOUND. */
export async function getVersion(companyId: string, versionId: string): Promise<BudgetVersion> {
  const rows = (await sql`
    SELECT v.*,
           to_char(v.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS approved_at_text,
           to_char(v.locked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS locked_at_text,
           to_char(v.unlocked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS unlocked_at_text,
           to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
           to_char(v.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text,
           (SELECT COUNT(*)::int FROM budget_month_amounts bm WHERE bm.company_id = v.company_id AND bm.version_id = v.id) AS amount_count,
           (SELECT COALESCE(SUM(bm.amount), 0)::numeric FROM budget_month_amounts bm WHERE bm.company_id = v.company_id AND bm.version_id = v.id) AS total
      FROM budget_versions v
     WHERE v.id = ${versionId}::UUID AND v.company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!rows[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  return mapVersion(rows[0]);
}

async function audit(companyId: string, actor: VersionActor, action: AuditAction, v: { id: string; fiscalYear: number; name: string }, metadata: Record<string, string>) {
  await logAuditOrThrow({
    companyId, userId: actor.userId, action, entityType: 'budget', entityId: v.id,
    entityRef: `FY${v.fiscalYear} ${v.name}`.slice(0, 100), changes: { fields: [], metadata: { fiscalYear: String(v.fiscalYear), ...metadata } },
  });
}

/** Inserts a draft; a clash (name taken, a second original) is a 409 before anything is poisoned. */
async function insertDraft(
  companyId: string, fiscalYear: number, name: string, kind: BudgetVersionKind, basedOn: string | null, actor: VersionActor,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO budget_versions (company_id, fiscal_year, name, kind, based_on_version_id, created_by)
    VALUES (${companyId}::UUID, ${fiscalYear}, ${name}, ${kind}, ${basedOn}::UUID, ${actor.userId})
    ON CONFLICT DO NOTHING
    RETURNING id
  `) as DbRow[];
  if (rows[0]) return String(rows[0].id);
  const original = kind === 'original'
    && ((await sql`SELECT 1 FROM budget_versions WHERE company_id = ${companyId}::UUID AND fiscal_year = ${fiscalYear} AND kind = 'original'`) as DbRow[]).length > 0;
  throw new BudgetVersionError('BUDGET_VERSION_STATE', original
    ? `FY${fiscalYear} already has an original budget`
    : `FY${fiscalYear} already has a budget version named '${name}'`);
}

export async function createVersion(
  companyId: string, input: { fiscalYear: number; name: unknown; kind: unknown }, actor: VersionActor,
): Promise<BudgetVersion> {
  const { name, kind } = parseVersionInput(input.name, input.kind);
  if (!(await getFiscalYear(companyId, input.fiscalYear))) {
    throw new BudgetVersionError('BUDGET_VERSION_INPUT', `No financial year is labelled ${input.fiscalYear}`);
  }
  const id = await insertDraft(companyId, input.fiscalYear, name, kind, null, actor);
  await audit(companyId, actor, 'create', { id, fiscalYear: input.fiscalYear, name }, { kind });
  return getVersion(companyId, id);
}

/** A draft copy of `sourceId` in the same year, with every amount at every grain; based_on = the source. */
export async function copyVersion(
  companyId: string, sourceId: string, input: { name: unknown; kind: unknown }, actor: VersionActor,
): Promise<BudgetVersion> {
  const { name, kind } = parseVersionInput(input.name, input.kind);
  // The source's year is locked so a concurrent delete of the source cannot race the copy.
  await lockVersionsOfYear(companyId, sourceId);
  const source = await getVersion(companyId, sourceId);
  const id = await insertDraft(companyId, source.fiscalYear, name, kind, source.id, actor);
  const copied = (await sql`
    WITH ins AS (
      INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, amount, created_by)
      SELECT company_id, ${id}::UUID, gl_account_id, cc1_id, cc2_id, bu_id, month, amount, ${actor.userId}
        FROM budget_month_amounts WHERE company_id = ${companyId}::UUID AND version_id = ${source.id}::UUID
      RETURNING amount
    )
    SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::text AS total FROM ins
  `) as DbRow[];
  const n = String(copied[0]?.n ?? 0), total = String(copied[0]?.total ?? '0');
  await audit(companyId, actor, 'create', { id, fiscalYear: source.fiscalYear, name }, { kind, copiedFrom: source.id, amounts: n, total });
  log.info('Copied budget version', { sourceId, versionId: id, amounts: n }, 'accounting');
  return getVersion(companyId, id);
}

/** Locks every version of the year (bounded), so primary changes and deletes of one year serialise. */
async function lockVersionsOfYear(companyId: string, versionId: string): Promise<{ fiscalYear: number }> {
  const v = await getVersion(companyId, versionId);
  await withRowLockBudget(
    () => sql`
      SELECT id FROM budget_versions WHERE company_id = ${companyId}::UUID AND fiscal_year = ${v.fiscalYear}
       ORDER BY id FOR UPDATE
    `,
    () => new RowLockTimeoutError('This budget year'),
  );
  return { fiscalYear: v.fiscalYear };
}

/** Makes `versionId` its year's primary (owner or admin); the readers follow it. */
export async function setPrimary(companyId: string, versionId: string, actor: VersionActor): Promise<BudgetVersion> {
  if (!APPROVERS.has(actor.role)) throw new BudgetVersionError('BUDGET_VERSION_FORBIDDEN', 'Only an owner or admin can change the primary budget');
  const { fiscalYear } = await lockVersionsOfYear(companyId, versionId);
  await sql`
    UPDATE budget_versions SET is_primary = false
     WHERE company_id = ${companyId}::UUID AND fiscal_year = ${fiscalYear} AND is_primary AND id <> ${versionId}::UUID
  `;
  await sql`UPDATE budget_versions SET is_primary = true WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID`;
  const v = await getVersion(companyId, versionId);
  await audit(companyId, actor, 'update', v, { primary: 'true' });
  return v;
}

/** Deletes a version that is neither primary nor locked; an approved one needs an owner or admin. */
export async function deleteVersion(companyId: string, versionId: string, actor: VersionActor): Promise<void> {
  // A writer who may never delete an approved version is refused before taking the year's locks.
  const seen = await getVersion(companyId, versionId);
  if (seen.status !== 'draft' && !APPROVERS.has(actor.role)) {
    throw new BudgetVersionError('BUDGET_VERSION_FORBIDDEN', 'Only an owner or admin can delete an approved budget version');
  }
  await lockVersionsOfYear(companyId, versionId);
  const v = await getVersion(companyId, versionId);
  if (v.isPrimary) throw new BudgetVersionError('BUDGET_VERSION_STATE', 'The primary budget cannot be deleted; make another version primary first');
  if (v.status === 'locked') throw new BudgetVersionError('BUDGET_VERSION_LOCKED', 'A locked budget version cannot be deleted');
  if (v.status === 'approved' && !APPROVERS.has(actor.role)) {
    throw new BudgetVersionError('BUDGET_VERSION_FORBIDDEN', 'Only an owner or admin can delete an approved budget version');
  }
  await sql`DELETE FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID`;
  await audit(companyId, actor, 'delete', v, { status: v.status, amounts: String(v.amountCount), total: String(v.total) });
}
