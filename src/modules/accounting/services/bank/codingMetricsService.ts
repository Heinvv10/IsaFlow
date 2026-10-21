/**
 * Learning-loop coding metrics — the SQL. Reads the counts codingMetrics.ts turns into rates (definitions
 * there). Three statements, each grouped by company, over a caller-supplied company set.
 *
 * TENANT SAFETY. `companyIds` is the caller's trusted set and every statement filters `company_id = ANY`:
 *  - the company endpoint passes [req.companyId] (withAuth: membership-checked, and under app_user the RLS
 *    policies bind the active company too);
 *  - the bureau endpoint passes the bureau's bureau_companies after the caller's bureau_users membership
 *    check, on the RLS-bypassing pool (bureau/services/.claude.md, "TENANT SAFETY").
 *
 * Headline semantics, as the code stands (verified 2026-10-21):
 *  - "coded" = feed_state 'posted' and status provisional / allocated / matched / reconciled, by the line's
 *    transaction_date in the period. Excluded and imported lines are not coded.
 *  - "no click" = auto_post_run_id (the confidence gate's sweep, autoPostGateService, tags every line it
 *    posts) or allocation_rule_id (bankRuleAutoPostLine sets it on a rule auto-post).
 *  - An undone run does not count: undoRow resets the line to imported (out of both counts) and clears
 *    auto_post_run_id; a reverse / unmatch clears allocation_rule_id with the allocation
 *    (bankTxStatusMutations, bankChainLineReversal).
 *  - A hand-corrected line does not count as auto-coded: markCorrectedByHand clears auto_post_run_id and
 *    leaves the line allocated, so it stays in the denominator only. A person's allocation clears
 *    allocation_rule_id (bankAllocationService), so a rule line re-coded by hand drops out too.
 * Period bounds for timestamps are South African calendar days (Africa/Johannesburg).
 */

import { sql } from '@/lib/neon';
import { FIRST_WINDOW_DAYS, type CompanyCodingCounts, type MonthPeriod } from './codingMetrics';

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());

export async function loadCodingCounts(companyIds: string[], period: MonthPeriod): Promise<CompanyCodingCounts[]> {
  if (companyIds.length === 0) return [];

  const lines = (await sql`
    SELECT company_id,
           COUNT(*)::int AS lines_coded,
           COUNT(*) FILTER (WHERE auto_post_run_id IS NOT NULL OR allocation_rule_id IS NOT NULL)::int AS lines_auto_coded
    FROM bank_transactions
    WHERE company_id = ANY(${companyIds}::UUID[])
      AND feed_state = 'posted'
      AND status IN ('provisional', 'allocated', 'matched', 'reconciled')
      AND transaction_date >= ${period.from}::DATE AND transaction_date < ${period.to}::DATE
    GROUP BY company_id
  `) as Array<{ company_id: string; lines_coded: number; lines_auto_coded: number }>;

  const decisions = (await sql`
    WITH bounds AS (
      SELECT (${period.from}::DATE::TIMESTAMP AT TIME ZONE 'Africa/Johannesburg') AS f,
             (${period.to}::DATE::TIMESTAMP AT TIME ZONE 'Africa/Johannesburg') AS t
    )
    SELECT d.company_id,
           -- A person's decisions only: decided_by NULL is ISAFlow superseding its own open suggestion.
           COUNT(*) FILTER (WHERE NOT d.was_auto_posted AND d.decided_by IS NOT NULL
                              AND d.outcome IN ('accepted', 'recoded', 'rejected')
                              AND d.decided_at >= b.f AND d.decided_at < b.t)::int AS suggestions_decided,
           COUNT(*) FILTER (WHERE NOT d.was_auto_posted AND d.decided_by IS NOT NULL AND d.outcome = 'accepted'
                              AND d.decided_at >= b.f AND d.decided_at < b.t)::int AS suggestions_accepted,
           COUNT(*) FILTER (WHERE d.was_auto_posted AND d.auto_posted_at >= b.f AND d.auto_posted_at < b.t)::int AS auto_posted,
           COUNT(*) FILTER (WHERE d.was_auto_posted AND d.auto_posted_at >= b.f AND d.auto_posted_at < b.t
                              AND d.outcome IN ('undone', 'recoded'))::int AS auto_posted_reversed,
           MIN(d.created_at) AS since
    FROM categorization_decisions d CROSS JOIN bounds b
    WHERE d.company_id = ANY(${companyIds}::UUID[])
    GROUP BY d.company_id
  `) as Array<{
    company_id: string; suggestions_decided: number; suggestions_accepted: number;
    auto_posted: number; auto_posted_reversed: number; since: Date | string | null;
  }>;

  // The first-days window: first bank import, else (no batch rows at all) the first bank line. Each line's
  // FIRST decision ever is counted when it falls inside the window.
  const firsts = (await sql`
    WITH starts AS (
      SELECT c.company_id,
             (SELECT MIN(b.created_at) FROM bank_import_batches b WHERE b.company_id = c.company_id) AS first_batch_at
      FROM unnest(${companyIds}::UUID[]) AS c(company_id)
    ),
    windows AS (
      SELECT s.company_id, s.first_batch_at,
             CASE WHEN s.first_batch_at IS NULL
                  THEN (SELECT MIN(t.created_at) FROM bank_transactions t WHERE t.company_id = s.company_id) END AS first_line_at
      FROM starts s
    ),
    first_decisions AS (
      SELECT DISTINCT ON (d.company_id, d.bank_transaction_id) d.company_id, d.outcome, d.created_at
      FROM categorization_decisions d
      WHERE d.company_id = ANY(${companyIds}::UUID[])
      ORDER BY d.company_id, d.bank_transaction_id, d.created_at, d.id
    )
    SELECT w.company_id, w.first_batch_at, w.first_line_at,
           COUNT(f.outcome) FILTER (WHERE f.outcome <> 'pending')::int AS decided,
           COUNT(f.outcome) FILTER (WHERE f.outcome = 'accepted')::int AS accepted
    FROM windows w
    LEFT JOIN first_decisions f
      ON f.company_id = w.company_id
     AND f.created_at >= COALESCE(w.first_batch_at, w.first_line_at)
     AND f.created_at < COALESCE(w.first_batch_at, w.first_line_at) + make_interval(days => ${FIRST_WINDOW_DAYS}::INT)
    GROUP BY w.company_id, w.first_batch_at, w.first_line_at
  `) as Array<{
    company_id: string; first_batch_at: Date | string | null; first_line_at: Date | string | null;
    decided: number; accepted: number;
  }>;

  const byId = <T extends { company_id: string }>(rows: T[]) => new Map(rows.map((r) => [String(r.company_id), r]));
  const l = byId(lines);
  const d = byId(decisions);
  const f = byId(firsts);
  return companyIds.map((companyId) => {
    const li = l.get(companyId);
    const de = d.get(companyId);
    const fi = f.get(companyId);
    return {
      companyId,
      linesCoded: Number(li?.lines_coded ?? 0),
      linesAutoCoded: Number(li?.lines_auto_coded ?? 0),
      suggestionsDecided: Number(de?.suggestions_decided ?? 0),
      suggestionsAccepted: Number(de?.suggestions_accepted ?? 0),
      autoPosted: Number(de?.auto_posted ?? 0),
      autoPostedReversed: Number(de?.auto_posted_reversed ?? 0),
      firstBatchAt: iso(fi?.first_batch_at),
      firstLineAt: iso(fi?.first_line_at),
      firstWindowDecided: Number(fi?.decided ?? 0),
      firstWindowAccepted: Number(fi?.accepted ?? 0),
      decisionLogSince: iso(de?.since),
    };
  });
}
