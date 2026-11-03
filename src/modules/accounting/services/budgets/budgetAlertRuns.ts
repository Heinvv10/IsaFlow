/**
 * When the company's budget alerts were last evaluated (budgets P5 spec §10: "timer never installed
 * → alerts silently never run" is answered by the controls page showing this).
 *
 * Where it lives: `accounting_settings` (the company's key/value settings, unique per company and
 * key, tenant RLS; 255/440), key `budget_alerts.last_evaluated`, value a JSON object
 * `{ at, source, fired, resolved }`. `at` is the DATABASE clock at the write, never the caller's.
 * No migration: 954's `budget_control_settings` has no column for it, and the newest `budget_alerts`
 * row cannot stand in (a run that crosses nothing writes no alert).
 *
 * Written in the SAME transaction as the evaluation it records, after it, so a failed run (rolled
 * back) leaves the previous time in place: the page then shows how stale the alerts are.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export const LAST_EVALUATED_KEY = 'budget_alerts.last_evaluated';

export type EvaluationSource = 'daily' | 'manual';

export interface LastEvaluated {
  /** ISO timestamp (database clock). */
  at: string;
  source: EvaluationSource;
  fired: number;
  resolved: number;
}

export async function recordEvaluated(
  companyId: string, run: { source: EvaluationSource; fired: number; resolved: number },
): Promise<void> {
  await sql`
    INSERT INTO accounting_settings (company_id, key, value)
    VALUES (${companyId}::UUID, ${LAST_EVALUATED_KEY},
            jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                               'source', ${run.source}::TEXT, 'fired', ${run.fired}::INT, 'resolved', ${run.resolved}::INT)::TEXT)
    ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

/** The last recorded evaluation, or null when none was ever recorded (or the stored value is unreadable). */
export async function readLastEvaluated(companyId: string): Promise<LastEvaluated | null> {
  const rows = (await sql`
    SELECT value FROM accounting_settings WHERE company_id = ${companyId}::UUID AND key = ${LAST_EVALUATED_KEY}
  `) as DbRow[];
  const raw = rows[0]?.value;
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null; // not ours to repair: the page says "never evaluated" and the next run overwrites it
  }
  const o = v as Partial<Record<keyof LastEvaluated, unknown>>;
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at)) || (o.source !== 'daily' && o.source !== 'manual')) return null;
  return { at: o.at, source: o.source, fired: Number(o.fired ?? 0), resolved: Number(o.resolved ?? 0) };
}
