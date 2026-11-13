/**
 * The three-way assumptions store (migration 983; P6 spec §4, §7, §13 items
 * 18-21; T9). One row per (company, version): a full document, or (scenarios)
 * `{ overrides }` of the base. company_id on every statement and join.
 *
 * Reads: `readChain` walks `based_on_version_id` from the target (same company
 * only: a base in another company reads as missing) with each version's stored
 * document and token, for the engine's `resolveAssumptions`.
 *
 * Write (`saveAssumptions`), inside withAuth's request transaction:
 *   holdYearRegistry (shared, before the registry is read, as every budget writer)
 *   → ONE savepoint: the version row FOR NO KEY UPDATE (bounded wait; the strength
 *     of P1's pre-lock UPDATE, but its `updated_at` is NOT bumped, so open grid
 *     tabs are not staled; it serialises assumption writers and means the lock
 *     trigger's FOR SHARE can never upgrade-deadlock) → 404 / 409 LOCKED before
 *     any write → the document validated (full, or overrides on a scenario whose
 *     chain resolves) → compare-and-set on the ROW's own `updated_at` (the
 *     client's `expectedUpdatedAt`; null = "no row yet") → INSERT or UPDATE →
 *     one audit row (entity 'budget', the version; before/after per section).
 * withAuth COMMITs a 4xx, so every refusal is thrown inside the savepoint and
 * rolls it back. Database refusals (BV001 the lock trigger) map through
 * `mapBudgetDbError`.
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { RowLockTimeoutError, withRowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import { logAuditOrThrow, type AuditFieldChange } from '@/modules/accounting/services/core/auditTrailService';
import { holdYearRegistry } from '../budgetVersionScope';
import { BudgetVersionError, mapBudgetDbError, type BudgetVersionKind, type BudgetVersionStatus } from '../budgetVersionTypes';
import { versionMonths } from '../drivers/driverRecomputeService';
import { tokenSql } from '../gridErrors';
import { MAX_SCENARIO_DEPTH, parseStoredDoc, resolveAssumptions, type ChainVersion } from './assumptionsChain';
import { defaultAssumptions } from './assumptionsDefaults';
import { isFullDoc, type StoredAssumptionsDoc } from './assumptionsSchema';
import { AssumptionChainError } from './errors';
import { addMonths } from './months';
import { AssumptionsStaleError } from './serviceErrors';

export interface StoredAssumptions {
  doc: StoredAssumptionsDoc;
  /** The row's token: UTC ISO text with microseconds. */
  updatedAt: string;
  updatedBy: string | null;
}

export interface ChainRead {
  versions: Map<string, ChainVersion>;
  /** The target's own row; null when it has none. */
  stored: StoredAssumptions | null;
}

/** Versions read up the chain: enough to see a cycle or a chain deeper than MAX_SCENARIO_DEPTH. */
const CHAIN_READ_LIMIT = MAX_SCENARIO_DEPTH + 2;

/** The target version and its bases (same company), each with its parsed document. */
export async function readChain(companyId: string, versionId: string): Promise<ChainRead> {
  const rows = (await sql`
    WITH RECURSIVE chain AS (
      SELECT v.id, v.fiscal_year, v.kind, v.based_on_version_id, 1 AS depth, ARRAY[v.id] AS path
        FROM budget_versions v WHERE v.id = ${versionId}::UUID AND v.company_id = ${companyId}::UUID
      UNION ALL
      SELECT b.id, b.fiscal_year, b.kind, b.based_on_version_id, c.depth + 1, c.path || b.id
        FROM chain c JOIN budget_versions b ON b.id = c.based_on_version_id AND b.company_id = ${companyId}::UUID
       WHERE c.depth < ${CHAIN_READ_LIMIT}::INT AND NOT b.id = ANY(c.path)
    )
    SELECT c.id::TEXT AS id, c.fiscal_year, c.kind, c.based_on_version_id::TEXT AS based_on,
           a.doc, to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS token, a.updated_by
      FROM chain c
      LEFT JOIN budget_three_way_assumptions a ON a.version_id = c.id AND a.company_id = ${companyId}::UUID
     ORDER BY c.depth
  `) as DbRow[];
  const versions = new Map<string, ChainVersion>();
  let stored: StoredAssumptions | null = null;
  for (const r of rows) {
    const id = String(r.id).toLowerCase();
    const doc = r.doc == null ? null : parseStoredDoc(r.doc);
    versions.set(id, {
      id, companyId, fiscalYear: Number(r.fiscal_year), kind: String(r.kind) as BudgetVersionKind,
      basedOnVersionId: r.based_on == null ? null : String(r.based_on).toLowerCase(), doc,
    });
    if (id === versionId.toLowerCase() && doc) stored = { doc, updatedAt: String(r.token), updatedBy: r.updated_by == null ? null : String(r.updated_by) };
  }
  if (!versions.has(versionId.toLowerCase())) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  return { versions, stored };
}

interface LockedVersion { fiscalYear: number; kind: BudgetVersionKind; status: BudgetVersionStatus }

/** The version row FOR NO KEY UPDATE, never bumped: 404 another company's, 409 locked. */
async function lockVersionRow(companyId: string, versionId: string): Promise<LockedVersion> {
  const rows = (await withRowLockBudget(
    () => sql`
      SELECT fiscal_year, kind, status FROM budget_versions
       WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
         FOR NO KEY UPDATE
    `,
    () => new RowLockTimeoutError('This budget version'),
  )) as DbRow[];
  const v = rows[0];
  if (!v) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  if (String(v.status) === 'locked') throw new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked');
  return { fiscalYear: Number(v.fiscal_year), kind: String(v.kind) as BudgetVersionKind, status: String(v.status) as BudgetVersionStatus };
}

/** Overrides must merge over a resolvable base: the chain is checked with the new document in place (structure only). */
async function assertChainResolves(companyId: string, versionId: string, fiscalYear: number, doc: StoredAssumptionsDoc): Promise<void> {
  const { versions } = await readChain(companyId, versionId);
  const target = versions.get(versionId) as ChainVersion;
  versions.set(versionId, { ...target, doc });
  const months = await versionMonths(companyId, fiscalYear);
  const shape = defaultAssumptions({
    priorYearEnd: addMonths(months[0] as string, -1), entityType: 'pty_ltd',
    vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' },
  });
  resolveAssumptions(versionId, versions, shape);
}

/** One audit field per top-level section that changed (an overrides document: per override section). */
export function sectionChanges(before: StoredAssumptionsDoc | null, after: StoredAssumptionsDoc): AuditFieldChange[] {
  const flat = (d: StoredAssumptionsDoc | null): Record<string, unknown> =>
    d === null ? {} : isFullDoc(d) ? { ...d } : Object.fromEntries(Object.entries(d.overrides).map(([k, v]) => [`overrides.${k}`, v]));
  const b = flat(before);
  const a = flat(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k !== 'schemaVersion').sort();
  const text = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  return keys
    .filter((k) => text(b[k]) !== text(a[k]))
    .map((k) => ({ field: `threeWay.${k}`, old: text(b[k]), new: text(a[k]), label: `Three-way assumptions: ${k}` }));
}

export interface SaveAssumptionsInput {
  versionId: string;
  doc: unknown;
  /** The row's token as the client read it; null when the client saw no row. */
  expectedUpdatedAt: string | null;
}

export async function saveAssumptions(companyId: string, userId: string, input: SaveAssumptionsInput): Promise<StoredAssumptions> {
  const versionId = input.versionId.toLowerCase();
  await holdYearRegistry(companyId);
  try {
    return await withSavepoint('budget_three_way_save', async () => {
      const version = await lockVersionRow(companyId, versionId);
      const doc = parseStoredDoc(input.doc);
      if (!isFullDoc(doc)) {
        if (version.kind !== 'scenario') {
          throw new AssumptionChainError('OVERRIDES_ON_NON_SCENARIO', 'Only a scenario version stores overrides; send a full document', [versionId]);
        }
        await assertChainResolves(companyId, versionId, version.fiscalYear, doc);
      }
      const cur = (await sql`
        SELECT doc, ${tokenSql()} AS token FROM budget_three_way_assumptions
         WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
         FOR UPDATE
      `) as DbRow[];
      const before = cur[0] ? parseStoredDoc(cur[0].doc) : null;
      const currentToken = cur[0] ? String(cur[0].token) : null;
      // "No row yet" must meet no row, and a token must meet a row; the UPDATE's WHERE compares the token itself.
      if ((currentToken === null) !== (input.expectedUpdatedAt === null)) throw new AssumptionsStaleError(currentToken);
      const json = JSON.stringify(doc);
      const written = (cur[0]
        ? await sql`
            UPDATE budget_three_way_assumptions SET doc = ${json}::JSONB, schema_version = 1
             WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
               AND updated_at = ${input.expectedUpdatedAt}::TIMESTAMPTZ
            RETURNING ${tokenSql()} AS token, updated_by`
        : await sql`
            INSERT INTO budget_three_way_assumptions (company_id, version_id, schema_version, doc)
            VALUES (${companyId}::UUID, ${versionId}::UUID, 1, ${json}::JSONB)
            RETURNING ${tokenSql()} AS token, updated_by`) as DbRow[];
      if (!written[0]) throw new AssumptionsStaleError(currentToken);
      await logAuditOrThrow({
        companyId, userId, action: before ? 'update' : 'create', entityType: 'budget', entityId: versionId,
        entityRef: `FY${version.fiscalYear} budget`,
        changes: {
          fields: sectionChanges(before, doc),
          metadata: {
            threeWayAction: 'assumptions', fiscalYear: String(version.fiscalYear), versionStatus: version.status,
            document: isFullDoc(doc) ? 'full' : 'overrides',
          },
        },
      });
      return { doc, updatedAt: String(written[0].token), updatedBy: written[0].updated_by == null ? null : String(written[0].updated_by) };
    });
  } catch (err) {
    return mapBudgetDbError(err);
  }
}
