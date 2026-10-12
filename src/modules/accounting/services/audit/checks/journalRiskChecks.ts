/**
 * Journal-risk checks (forensic-controls step 4): leads over the POSTED
 * journals dated in the run's window, each a fact a person should look at —
 * never a conclusion that anything is wrong.
 *
 *  backdated_entry          recorded (posted_at, else created_at) more than
 *                           BACKDATE_DAYS after its accounting date — the
 *                           board pack's test. A recording day with
 *                           BULK_LOAD_MIN or more of them is one bulk-load
 *                           finding, not hundreds (a ledger reload).
 *  posted_after_period_close posted after the recorded close (closed_at) of
 *                           the fiscal period its date falls in.
 *  outside_business_hours   a MANUAL journal posted outside 08:00–18:00 SAST
 *                           or on a weekend (system postings run at night by
 *                           design and are not leads).
 *  reversal_relation        a reversal dated in a different fiscal period
 *                           from the journal it reverses, or a reversal of a
 *                           reversal.
 *  threshold_split          two or more manual journals by one person on one
 *                           SAST day, each below an active manual-journal
 *                           approval threshold, together over it.
 */
import { sql } from '@/lib/neon';
import { BACKDATE_DAYS, BULK_LOAD_MIN } from '@/modules/accounting/services/reports/unusualJournalsService';
import { money, result, type CheckResult, type CheckWindow, type Finding } from './checkTypes';

export const JOURNAL_RISK_CHECK_VERSION = 1;
type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function population(w: CheckWindow, manualOnly: boolean): Promise<number> {
  const [r] = (await sql`
    SELECT count(*)::INT AS n FROM gl_journal_entries
    WHERE company_id = ${w.companyId}::UUID AND status = 'posted'
      AND entry_date BETWEEN ${w.from}::DATE AND ${w.to}::DATE AND (NOT ${manualOnly} OR source = 'manual')
  `) as { n: number }[];
  return r!.n;
}

async function backdated(w: CheckWindow): Promise<CheckResult> {
  const rows = (await sql`
    WITH late AS (
      SELECT je.id, je.entry_number, je.entry_date, COALESCE(je.posted_at, je.created_at) AS recorded,
             ((COALESCE(je.posted_at, je.created_at) AT TIME ZONE 'Africa/Johannesburg')::DATE) AS recorded_day
      FROM gl_journal_entries je
      WHERE je.company_id = ${w.companyId}::UUID AND je.status = 'posted'
        AND je.entry_date BETWEEN ${w.from}::DATE AND ${w.to}::DATE
        AND COALESCE(je.posted_at, je.created_at) > (je.entry_date::TIMESTAMP AT TIME ZONE 'UTC') + make_interval(days => ${BACKDATE_DAYS})
    ), days AS (SELECT recorded_day, count(*)::INT AS n FROM late GROUP BY recorded_day)
    SELECT l.id::TEXT AS id, l.entry_number, l.entry_date::TEXT AS entry_date, l.recorded_day::TEXT AS recorded_day,
           (l.recorded::DATE - l.entry_date) AS days_late, d.n AS day_count
    FROM late l JOIN days d USING (recorded_day)
    ORDER BY l.recorded_day, l.entry_date, l.id
  `) as Row[];
  const findings: Finding[] = [];
  const bulk = new Map<string, string[]>();
  for (const r of rows) {
    if (Number(r.day_count) >= BULK_LOAD_MIN) {
      const day = String(r.recorded_day);
      bulk.set(day, [...(bulk.get(day) ?? []), String(r.id)]);
      continue;
    }
    findings.push({ key: `journal:${r.id}`, refs: [String(r.id)], detail: {
      entry_number: s(r.entry_number), entry_date: String(r.entry_date), recorded_day: String(r.recorded_day), days_late: Number(r.days_late) } });
  }
  for (const [day, ids] of bulk) {
    findings.push({ key: `bulk_load:${day}`, refs: ids.slice(0, 50), detail: { recorded_day: day, journals: ids.length } });
  }
  return result('journal_risk.backdated_entry', JOURNAL_RISK_CHECK_VERSION, 'journal_risk', await population(w, false), findings);
}

async function afterClose(w: CheckWindow): Promise<CheckResult> {
  const rows = (await sql`
    SELECT je.id::TEXT AS id, je.entry_number, je.entry_date::TEXT AS entry_date, fp.period_name,
           to_char(fp.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at,
           to_char(je.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS posted_at
    FROM gl_journal_entries je
    JOIN fiscal_periods fp ON fp.company_id = je.company_id AND je.entry_date BETWEEN fp.start_date AND fp.end_date
    WHERE je.company_id = ${w.companyId}::UUID AND je.status = 'posted'
      AND je.entry_date BETWEEN ${w.from}::DATE AND ${w.to}::DATE
      AND fp.closed_at IS NOT NULL AND je.posted_at > fp.closed_at
    ORDER BY je.entry_date, je.id
  `) as Row[];
  return result('journal_risk.posted_after_period_close', JOURNAL_RISK_CHECK_VERSION, 'journal_risk', await population(w, false),
    rows.map((r) => ({ key: `journal:${r.id}`, refs: [String(r.id)], detail: {
      entry_number: s(r.entry_number), entry_date: String(r.entry_date), period: s(r.period_name),
      period_closed_at: s(r.closed_at), posted_at: s(r.posted_at) } })));
}

async function outsideHours(w: CheckWindow): Promise<CheckResult> {
  const rows = (await sql`
    SELECT id::TEXT AS id, entry_number, entry_date::TEXT AS entry_date, local::TEXT AS local_time,
           EXTRACT(ISODOW FROM local)::INT AS dow
    FROM (SELECT je.*, (COALESCE(je.posted_at, je.created_at) AT TIME ZONE 'Africa/Johannesburg') AS local
          FROM gl_journal_entries je
          WHERE je.company_id = ${w.companyId}::UUID AND je.status = 'posted' AND je.source = 'manual'
            AND je.entry_date BETWEEN ${w.from}::DATE AND ${w.to}::DATE) j
    WHERE EXTRACT(ISODOW FROM local) IN (6, 7) OR EXTRACT(HOUR FROM local) < 8 OR EXTRACT(HOUR FROM local) >= 18
    ORDER BY entry_date, id
  `) as Row[];
  return result('journal_risk.outside_business_hours', JOURNAL_RISK_CHECK_VERSION, 'journal_risk', await population(w, true),
    rows.map((r) => ({ key: `journal:${r.id}`, refs: [String(r.id)], detail: {
      entry_number: s(r.entry_number), entry_date: String(r.entry_date), posted_local: String(r.local_time).slice(0, 19),
      weekend: Number(r.dow) >= 6 } })));
}

async function reversals(w: CheckWindow): Promise<CheckResult> {
  const rows = (await sql`
    SELECT rv.id::TEXT AS id, rv.entry_number, rv.entry_date::TEXT AS entry_date, o.id::TEXT AS original_id,
           o.entry_number AS original_number, o.entry_date::TEXT AS original_date,
           (o.reversal_of_id IS NOT NULL) AS reverses_a_reversal
    FROM gl_journal_entries rv
    JOIN gl_journal_entries o ON o.id = rv.reversal_of_id AND o.company_id = rv.company_id
    LEFT JOIN fiscal_periods fr ON fr.company_id = rv.company_id AND rv.entry_date BETWEEN fr.start_date AND fr.end_date
    LEFT JOIN fiscal_periods fo ON fo.company_id = o.company_id AND o.entry_date BETWEEN fo.start_date AND fo.end_date
    WHERE rv.company_id = ${w.companyId}::UUID AND rv.status = 'posted'
      AND rv.entry_date BETWEEN ${w.from}::DATE AND ${w.to}::DATE
      AND (o.reversal_of_id IS NOT NULL OR fr.id IS DISTINCT FROM fo.id
           OR (fr.id IS NULL AND date_trunc('month', rv.entry_date) <> date_trunc('month', o.entry_date)))
    ORDER BY rv.entry_date, rv.id
  `) as Row[];
  return result('journal_risk.reversal_relation', JOURNAL_RISK_CHECK_VERSION, 'journal_risk', await population(w, false),
    rows.map((r) => ({ key: `reversal:${r.id}`, refs: [String(r.id), String(r.original_id)], detail: {
      entry_number: s(r.entry_number), entry_date: String(r.entry_date), original_number: s(r.original_number),
      original_date: String(r.original_date), reverses_a_reversal: Boolean(r.reverses_a_reversal) } })));
}

async function thresholdSplits(w: CheckWindow): Promise<CheckResult> {
  const rows = (await sql`
    WITH rules AS (
      SELECT id, condition_value AS bound, condition_operator AS op FROM approval_rules
      WHERE company_id = ${w.companyId}::UUID AND is_active IS TRUE AND document_type = 'manual_journal'
        AND condition_operator IN ('greater_than', 'greater_equal') AND condition_value > 0
    ), j AS (
      SELECT je.id, je.created_by, (je.created_at AT TIME ZONE 'Africa/Johannesburg')::DATE AS day,
             (SELECT COALESCE(sum(jl.debit), 0) FROM gl_journal_lines jl
               WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id) AS amount
      FROM gl_journal_entries je
      WHERE je.company_id = ${w.companyId}::UUID AND je.status = 'posted' AND je.source = 'manual'
        AND je.entry_date BETWEEN ${w.from}::DATE AND ${w.to}::DATE
    )
    SELECT r.id::TEXT AS rule_id, r.bound::TEXT AS bound, j.created_by::TEXT AS person, j.day::TEXT AS day,
           array_agg(j.id::TEXT ORDER BY j.id) AS ids, sum(j.amount)::TEXT AS total
    FROM rules r JOIN j ON j.amount > 0 AND (CASE r.op WHEN 'greater_than' THEN j.amount <= r.bound ELSE j.amount < r.bound END)
    GROUP BY r.id, r.bound, r.op, j.created_by, j.day
    HAVING count(*) > 1 AND (CASE r.op WHEN 'greater_than' THEN sum(j.amount) > r.bound ELSE sum(j.amount) >= r.bound END)
    ORDER BY j.day, r.id, j.created_by
  `) as Row[];
  return result('journal_risk.threshold_split', JOURNAL_RISK_CHECK_VERSION, 'journal_risk', await population(w, true),
    rows.map((r) => ({ key: `split:${r.rule_id}:${r.person}:${r.day}`, refs: r.ids as string[], detail: {
      rule_id: String(r.rule_id), threshold: money(r.bound), person: s(r.person), day: String(r.day),
      journals: (r.ids as string[]).length, total: money(r.total) } })));
}

export async function runJournalRiskChecks(w: CheckWindow): Promise<CheckResult[]> {
  return [await backdated(w), await afterClose(w), await outsideHours(w), await reversals(w), await thresholdSplits(w)];
}
