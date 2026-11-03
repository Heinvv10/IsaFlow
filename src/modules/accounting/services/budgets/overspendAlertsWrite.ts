/**
 * The overspend evaluator's writes to `budget_alerts` (migration 954), set-based, every statement
 * scoped by company. The unique key (company, version, account, slice, month, threshold) IS the
 * dedupe: one row per crossing, ever.
 *
 * - `insertCrossings`: INSERT ... ON CONFLICT DO NOTHING RETURNING: only a row this call created
 *   comes back, so only it is announced. A concurrent evaluator's insert, or an existing row, returns
 *   nothing (a rerun is idempotent).
 * - `refireResolved`: a crossing whose row is RESOLVED is open again (resolved_at cleared; 954's
 *   trigger re-stamps fired_at), and comes back to be announced again. The WHERE repeats
 *   `resolved_at IS NOT NULL`, so two racing evaluators re-fire it once.
 * - `refreshOpen`: an open crossing's figures follow the books (no announcement).
 * - `resolveUncrossed`: every open alert of the company in the evaluated months that is not crossed
 *   now (below its threshold, a threshold no longer configured, a budget removed, another version)
 *   is resolved (954's trigger stamps resolved_at with the clock).
 * A crossing's `pct` is sent as text: JSON has no Infinity, NUMERIC does (spend against R0).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { Crossing, SliceDims } from './overspendAlertsCore';

export interface AlertRow extends SliceDims {
  id: string;
  glAccountId: string;
  /** 'YYYY-MM'. */
  month: string;
  threshold: number;
  budget: number;
  actual: number;
  committed: number;
  /** Infinity for spend against a zero budget. */
  pct: number;
  firedAt: string;
}

const text = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** The crossings as the JSON rows every statement reads with jsonb_to_recordset. */
function payload(versionId: string, crossings: readonly Crossing[]): string {
  return JSON.stringify(crossings.map((c) => ({
    version_id: versionId, gl_account_id: c.glAccountId, cc1_id: c.cc1Id, cc2_id: c.cc2Id, bu_id: c.buId,
    month: `${c.month}-01`, threshold: c.threshold, budget: c.budget, actual: c.actual, committed: c.committed,
    pct: Number.isFinite(c.pct) ? String(c.pct) : 'Infinity',
  })));
}

const RECORD = sql.unsafe(`c(version_id UUID, gl_account_id UUID, cc1_id UUID, cc2_id UUID, bu_id UUID, month DATE,
  threshold NUMERIC, budget NUMERIC, actual NUMERIC, committed NUMERIC, pct TEXT)`);
const MATCH = sql.unsafe(`a.version_id = c.version_id AND a.gl_account_id = c.gl_account_id
  AND a.cc1_id IS NOT DISTINCT FROM c.cc1_id AND a.cc2_id IS NOT DISTINCT FROM c.cc2_id AND a.bu_id IS NOT DISTINCT FROM c.bu_id
  AND a.month = c.month AND a.threshold = c.threshold`);
const RETURNED = sql.unsafe(`a.id::TEXT AS id, a.gl_account_id::TEXT AS gl_account_id, a.cc1_id::TEXT AS cc1_id,
  a.cc2_id::TEXT AS cc2_id, a.bu_id::TEXT AS bu_id, to_char(a.month, 'YYYY-MM') AS month, a.threshold::TEXT AS threshold,
  a.budget::TEXT AS budget, a.actual::TEXT AS actual, a.committed::TEXT AS committed, a.pct::TEXT AS pct, a.fired_at`);

function mapRow(r: DbRow): AlertRow {
  return {
    id: String(r.id), glAccountId: String(r.gl_account_id), cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id),
    month: String(r.month), threshold: Number(r.threshold), budget: Number(r.budget), actual: Number(r.actual),
    committed: Number(r.committed), pct: Number(r.pct), firedAt: iso(r.fired_at),
  };
}

export async function insertCrossings(companyId: string, versionId: string, crossings: readonly Crossing[]): Promise<AlertRow[]> {
  if (crossings.length === 0) return [];
  const rows = (await sql`
    INSERT INTO budget_alerts AS a (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, threshold, budget, actual, committed, pct)
    SELECT ${companyId}::UUID, c.version_id, c.gl_account_id, c.cc1_id, c.cc2_id, c.bu_id, c.month, c.threshold,
           c.budget, c.actual, c.committed, c.pct::NUMERIC
      FROM jsonb_to_recordset(${payload(versionId, crossings)}::JSONB) AS ${RECORD}
    ON CONFLICT DO NOTHING
    RETURNING ${RETURNED}
  `) as DbRow[];
  return rows.map(mapRow);
}

export async function refireResolved(companyId: string, versionId: string, crossings: readonly Crossing[]): Promise<AlertRow[]> {
  if (crossings.length === 0) return [];
  const rows = (await sql`
    UPDATE budget_alerts a
       SET resolved_at = NULL, budget = c.budget, actual = c.actual, committed = c.committed, pct = c.pct::NUMERIC
      FROM jsonb_to_recordset(${payload(versionId, crossings)}::JSONB) AS ${RECORD}
     WHERE a.company_id = ${companyId}::UUID AND ${MATCH} AND a.resolved_at IS NOT NULL
    RETURNING ${RETURNED}
  `) as DbRow[];
  return rows.map(mapRow);
}

export async function refreshOpen(companyId: string, versionId: string, crossings: readonly Crossing[]): Promise<void> {
  if (crossings.length === 0) return;
  await sql`
    UPDATE budget_alerts a
       SET budget = c.budget, actual = c.actual, committed = c.committed, pct = c.pct::NUMERIC
      FROM jsonb_to_recordset(${payload(versionId, crossings)}::JSONB) AS ${RECORD}
     WHERE a.company_id = ${companyId}::UUID AND ${MATCH} AND a.resolved_at IS NULL
       AND (a.budget, a.actual, a.committed, a.pct) IS DISTINCT FROM (c.budget, c.actual, c.committed, c.pct::NUMERIC)
  `;
}

/** Resolves the open alerts of `[firstMonth, lastMonth]` ('YYYY-MM-01') that `crossings` does not hold; their ids. */
export async function resolveUncrossed(
  companyId: string, versionId: string | null, crossings: readonly Crossing[], firstMonth: string, lastMonth: string,
): Promise<string[]> {
  const rows = (await sql`
    UPDATE budget_alerts a SET resolved_at = clock_timestamp()
     WHERE a.company_id = ${companyId}::UUID AND a.resolved_at IS NULL
       AND a.month BETWEEN ${firstMonth}::DATE AND ${lastMonth}::DATE
       AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${payload(versionId ?? '', crossings)}::JSONB) AS ${RECORD} WHERE ${MATCH})
    RETURNING a.id::TEXT AS id
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}
