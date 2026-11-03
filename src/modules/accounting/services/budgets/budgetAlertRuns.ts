/**
 * When the company's budget alerts were last evaluated (budgets P5 spec §10: "timer never installed
 * → alerts silently never run" is answered by the controls page showing this).
 *
 * Where it lives: `accounting_settings` (the company's key/value settings, unique per company and
 * key, tenant RLS; 255/440), ONE KEY PER SOURCE so Evaluate now never hides a daily run that does
 * not happen: `budget_alerts.last_evaluated.daily` and `budget_alerts.last_evaluated.manual`, each a
 * JSON object `{ at, source, fired, resolved }`. `at` is the DATABASE clock at the write.
 * No migration: 954's `budget_control_settings` has no column for it, and the newest `budget_alerts`
 * row cannot stand in (a run that crosses nothing writes no alert).
 *
 * Written in the SAME transaction as the evaluation it records, after it, so a failed run (rolled
 * back) leaves the previous time in place: the page then shows how stale the alerts are.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export type EvaluationSource = 'daily' | 'manual';

export const LAST_EVALUATED_KEYS: Readonly<Record<EvaluationSource, string>> = {
  daily: 'budget_alerts.last_evaluated.daily',
  manual: 'budget_alerts.last_evaluated.manual',
};

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
    VALUES (${companyId}::UUID, ${LAST_EVALUATED_KEYS[run.source]},
            jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                               'source', ${run.source}::TEXT, 'fired', ${run.fired}::INT, 'resolved', ${run.resolved}::INT)::TEXT)
    ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

/** The last run of each source: the daily run's and Evaluate now's (null: never recorded). */
export interface LastEvaluations {
  daily: LastEvaluated | null;
  manual: LastEvaluated | null;
}

function parse(raw: unknown, source: EvaluationSource): LastEvaluated | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null; // not ours to repair: the page says "never" and the next run of this source overwrites it
  }
  const o = v as Partial<Record<keyof LastEvaluated, unknown>>;
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at)) || o.source !== source) return null;
  return { at: o.at, source, fired: Number(o.fired ?? 0), resolved: Number(o.resolved ?? 0) };
}

export async function readLastEvaluated(companyId: string): Promise<LastEvaluations> {
  const rows = (await sql`
    SELECT key, value FROM accounting_settings
     WHERE company_id = ${companyId}::UUID AND key = ANY(${[LAST_EVALUATED_KEYS.daily, LAST_EVALUATED_KEYS.manual]}::TEXT[])
  `) as DbRow[];
  const valueOf = (source: EvaluationSource) => rows.find((r) => r.key === LAST_EVALUATED_KEYS[source])?.value;
  return { daily: parse(valueOf('daily'), 'daily'), manual: parse(valueOf('manual'), 'manual') };
}
