/**
 * Undo a change of financial year end (Feature G), in the request transaction.
 *
 * Allowed while nothing has been built on the new layout: no period after the
 * earlier of the original and the new year end has been closed or locked, and
 * the transition year has no year-end closing journal. Only the company's
 * latest live change can be undone.
 *
 * It restores the change's snapshot exactly: the transition year's end, kind
 * and change link; the later years with their original ids, labels, dates and
 * created_at; every period's year, label, number and name. Periods generated
 * by or after the change that nothing references are deleted again; one that
 * something does reference (a journal posted into it since) is kept and
 * re-linked to the restored year that holds its dates. The company's
 * financial_year_start goes back, the change is marked reversed and the audit
 * log records it.
 */

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '../core/auditTrailService';
import { repointPeriodToItsYear, YearEndChangeRefusedError } from './financialYearEndChangeApply';

interface SnapYear { id: string; fiscal_year: number; start_date: string; end_date: string; kind: string; change_id: string | null; created_at: string }
interface SnapPeriod { id: string; fiscal_year_id: string; fiscal_year: number; period_number: number; period_name: string }

export interface LiveChange {
  id: string;
  fiscalYearId: string | null;
  fromStartMonth: number;
  fromEndDate: string;
  toEndDate: string;
  transitionStart: string;
  snapshot: { years: SnapYear[]; periods: SnapPeriod[] };
}

export async function latestLiveChange(companyId: string): Promise<LiveChange | null> {
  const rows = (await sql`
    SELECT id, fiscal_year_id, from_start_month, from_end_date, to_end_date, transition_start, snapshot
      FROM fiscal_year_end_changes WHERE company_id = ${companyId}::UUID AND reversed_at IS NULL
     ORDER BY applied_at DESC LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), fiscalYearId: r.fiscal_year_id ? String(r.fiscal_year_id) : null, fromStartMonth: Number(r.from_start_month),
    fromEndDate: fmtDate(r.from_end_date), toEndDate: fmtDate(r.to_end_date), transitionStart: fmtDate(r.transition_start),
    snapshot: r.snapshot as LiveChange['snapshot'],
  };
}

export interface YearEndChangeRecord {
  id: string;
  fromEndDate: string;
  toEndDate: string;
  transitionStart: string;
  months: number;
  reason: string;
  appliedBy: string;
  appliedAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
}

/** Every change, newest first (Settings shows the history). */
export async function listYearEndChanges(companyId: string): Promise<YearEndChangeRecord[]> {
  const rows = (await sql`
    SELECT c.id, c.from_end_date, c.to_end_date, c.transition_start, c.months, c.reason, c.applied_at, c.reversed_at,
           c.reversal_reason, COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email, c.applied_by::text) AS applied_by
      FROM fiscal_year_end_changes c LEFT JOIN users u ON u.id::text = c.applied_by::text
     WHERE c.company_id = ${companyId}::UUID
     ORDER BY c.applied_at DESC
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id), fromEndDate: fmtDate(r.from_end_date), toEndDate: fmtDate(r.to_end_date),
    transitionStart: fmtDate(r.transition_start), months: Number(r.months), reason: String(r.reason),
    appliedBy: String(r.applied_by), appliedAt: new Date(String(r.applied_at)).toISOString(),
    reversedAt: r.reversed_at ? new Date(String(r.reversed_at)).toISOString() : null,
    reversalReason: r.reversal_reason ? String(r.reversal_reason) : null,
  }));
}

/** Why the latest change cannot be undone (empty: it can). */
export async function undoRefusals(companyId: string, change: LiveChange | null): Promise<string[]> {
  if (!change) return ['There is no change of financial year end to undo.'];
  const out: string[] = [];
  const boundary = change.toEndDate < change.fromEndDate ? change.toEndDate : change.fromEndDate;
  const closed = (await sql`
    SELECT period_name FROM fiscal_periods
     WHERE company_id = ${companyId}::UUID AND start_date > ${boundary}::DATE AND status IN ('closing', 'closed', 'locked')
     ORDER BY start_date LIMIT 6
  `) as DbRow[];
  if (closed.length > 0) {
    out.push(`Periods after ${boundary} have already been closed (${closed.map((r) => r.period_name).join(', ')}); `
      + 'the change can no longer be undone.');
  }
  const ty = change.fiscalYearId ? (await sql`
    SELECT status FROM fiscal_years WHERE id = ${change.fiscalYearId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[] : [];
  if (!ty[0]) out.push('The transition year this change made no longer exists; it cannot be undone.');
  else if (String(ty[0].status) !== 'open') {
    out.push(`The transition year is ${String(ty[0].status)}; reopen its periods before undoing the change.`);
  }
  const ye = (await sql`
    SELECT COUNT(*)::int AS n FROM gl_journal_entries
     WHERE company_id = ${companyId}::UUID AND source = 'year_end'
       AND entry_date BETWEEN ${change.transitionStart}::DATE AND ${change.toEndDate}::DATE
  `) as DbRow[];
  if (Number(ye[0]!.n) > 0) out.push('The transition year has a year-end closing journal; the change can no longer be undone.');
  return out;
}

const REFERENCED = (id: string) => sql`
  SELECT (EXISTS (SELECT 1 FROM gl_journal_entries WHERE fiscal_period_id = ${id}::UUID)
       OR EXISTS (SELECT 1 FROM gl_account_balances WHERE fiscal_period_id = ${id}::UUID)
       OR EXISTS (SELECT 1 FROM close_runs WHERE fiscal_period_id = ${id}::UUID)
       OR EXISTS (SELECT 1 FROM gl_entry_date_corrections
                   WHERE old_fiscal_period_id = ${id}::UUID OR new_fiscal_period_id = ${id}::UUID)) AS used
`;

export async function undoYearEndChange(companyId: string, userId: string, reason: string): Promise<{ changeId: string }> {
  if (!als.getStore()?.client) throw new Error('undoYearEndChange must run inside the request transaction');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fy-end-change:${companyId}`}, 0))`;
  const change = await latestLiveChange(companyId);
  const refusals = await undoRefusals(companyId, change);
  if (refusals.length > 0 || !change) throw new YearEndChangeRefusedError(refusals);
  const snap = change.snapshot;
  const snapPeriodIds = new Set(snap.periods.map((p) => p.id));
  const transition = snap.years.find((y) => y.id === change.fiscalYearId);
  if (!transition) throw new Error(`Change ${change.id}: its snapshot does not hold the transition year`);

  await sql`SET CONSTRAINTS fiscal_periods_fiscal_year_id_fkey, fiscal_years_change_id_fkey DEFERRED`;
  await sql`DELETE FROM fiscal_years WHERE company_id = ${companyId}::UUID AND start_date > ${change.transitionStart}::DATE`;
  await sql`
    UPDATE fiscal_years SET end_date = ${transition.end_date}::DATE, kind = ${transition.kind},
           change_id = ${transition.change_id}::UUID
     WHERE id = ${change.fiscalYearId}::UUID AND company_id = ${companyId}::UUID
  `;
  for (const y of snap.years) {
    if (y.id === change.fiscalYearId) continue;
    // The one place outside the generator that writes a year: the snapshot's own row, back with its own id.
    await sql`
      INSERT INTO fiscal_years (id, company_id, fiscal_year, start_date, end_date, kind, change_id, created_at)
      VALUES (${y.id}::UUID, ${companyId}::UUID, ${y.fiscal_year}, ${y.start_date}::DATE, ${y.end_date}::DATE,
              ${y.kind}, ${y.change_id}::UUID, ${y.created_at}::TIMESTAMPTZ)
    `;
  }

  // The old start month first: a period re-linked below is placed by the template.
  await sql`UPDATE companies SET financial_year_start = ${change.fromStartMonth} WHERE id = ${companyId}::UUID`;

  // The periods the change moved or made: those after the earlier of the two
  // year ends (the ones before it, closed ones included, were never touched).
  // Free their keys, then restore.
  const boundary = change.toEndDate < change.fromEndDate ? change.toEndDate : change.fromEndDate;
  const current = (await sql`
    UPDATE fiscal_periods SET period_number = -period_number - 1000
     WHERE company_id = ${companyId}::UUID AND start_date > ${boundary}::DATE
    RETURNING id, start_date::text AS start_date
  `) as DbRow[];
  const currentIds = new Set(current.map((p) => String(p.id)));
  for (const p of snap.periods) {
    if (!currentIds.has(p.id)) continue;
    await sql`
      UPDATE fiscal_periods SET fiscal_year_id = ${p.fiscal_year_id}::UUID, fiscal_year = ${p.fiscal_year},
             period_number = ${p.period_number}, period_name = ${p.period_name}
       WHERE id = ${p.id}::UUID AND company_id = ${companyId}::UUID
    `;
  }
  for (const p of current) {
    const id = String(p.id);
    if (snapPeriodIds.has(id)) continue;
    const used = ((await REFERENCED(id)) as DbRow[])[0]!.used === true;
    if (!used) {
      await sql`DELETE FROM fiscal_periods WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
      continue;
    }
    await repointPeriodToItsYear(companyId, id, String(p.start_date));
  }

  await sql`
    UPDATE fiscal_year_end_changes SET reversed_by = ${userId}::UUID, reversed_at = NOW(), reversal_reason = ${reason}
     WHERE id = ${change.id}::UUID AND company_id = ${companyId}::UUID
  `;
  await sql`SET CONSTRAINTS fiscal_periods_fiscal_year_id_fkey, fiscal_years_change_id_fkey IMMEDIATE`;

  await logAuditOrThrow({
    companyId, userId, action: 'reverse', entityType: 'fiscal_year_end_change', entityId: change.id,
    entityRef: `undo ${change.transitionStart}..${change.toEndDate} -> ${change.fromEndDate}`,
    changes: {
      fields: [
        { field: 'year_end', label: 'Financial year end', old: change.toEndDate, new: change.fromEndDate },
        { field: 'financial_year_start', label: 'Financial year start month', old: null, new: String(change.fromStartMonth) },
      ],
      metadata: { reason },
    },
  });
  log.info('Financial year end change undone', { companyId, changeId: change.id }, 'accounting');
  return { changeId: change.id };
}
