/**
 * Engagement Budget status per practice job (migration 850).
 *
 * Consumption is ALL time on the job, not just billed time: every time entry
 * with that `job_id` in the same company, at every status except `leave` —
 * draft, submitted, approved, billed, invoiced, non-billable and written-off
 * (`not_billable`) all spend the engagement's budget. Each entry is valued at
 * ROUND(hours × applied_rate, 2), the same per-line rounding `line_total` uses,
 * and computed here rather than read from `line_total` so the rule does not
 * depend on how a non-billable line was stored. An entry with no rate adds its
 * hours but no rand.
 *
 * Both joins are company-scoped (`te.company_id = pj.company_id`, likewise the
 * client): `time_entries.job_id` is a tenant-agnostic FK, so another company's
 * entry can point at this job. The entry must also be the job's own client's
 * (`te.practice_client_id = pj.practice_client_id`): migration 851 enforces
 * that for new rows, and this keeps a legacy mismatched row out of the sum.
 * The client name is `trading_name` falling back to `legal_name`, as the
 * client pickers show it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { PracticeJob } from './practiceJobTypes';
import { budgetFigures, type JobBudgetStatus } from './practiceJobBudget';

export type { JobBudgetStatus, JobBudgetState } from './practiceJobBudget';

export interface JobBudgetRow extends JobBudgetStatus {
  title: string;
  jobStatus: PracticeJob['status'];
  practiceClientId: string;
  practiceClientName: string | null;
}

export interface JobBudgetFilters {
  practiceClientId?: string;
  jobId?: string;
}

/** Over first, then warning, ok, and jobs with no budget last. */
const STATE_ORDER: Record<JobBudgetStatus['state'], number> = { over: 0, warning: 1, ok: 2, none: 3 };

function mapRow(r: DbRow): JobBudgetRow {
  const budgetAmount = r.budget_amount != null ? Number(r.budget_amount) : null;
  const consumedAmount = Number(r.consumed_amount);
  return {
    jobId: String(r.id),
    budgetAmount,
    consumedAmount,
    ...budgetFigures(budgetAmount, consumedAmount),
    budgetedHours: r.budgeted_hours != null ? Number(r.budgeted_hours) : null,
    hoursUsed: Number(r.hours_used),
    title: String(r.title),
    jobStatus: String(r.status) as PracticeJob['status'],
    practiceClientId: String(r.practice_client_id),
    practiceClientName: r.practice_client_name ? String(r.practice_client_name) : null,
  };
}

export async function listJobBudgetStatuses(
  companyId: string,
  filters: JobBudgetFilters = {},
): Promise<JobBudgetRow[]> {
  const clientId = filters.practiceClientId ?? null;
  const jobId = filters.jobId ?? null;
  const rows = (await sql`
    SELECT pj.id, pj.title, pj.status, pj.practice_client_id, pj.budget_amount, pj.budgeted_hours,
           COALESCE(pc.trading_name, pc.legal_name) AS practice_client_name,
           COALESCE(SUM(ROUND(te.hours * te.applied_rate, 2)), 0) AS consumed_amount,
           COALESCE(SUM(te.hours), 0) AS hours_used
    FROM practice_jobs pj
    LEFT JOIN practice_clients pc
      ON pc.id = pj.practice_client_id AND pc.company_id = pj.company_id
    LEFT JOIN time_entries te
      ON te.job_id = pj.id
     AND te.company_id = pj.company_id
     AND te.practice_client_id = pj.practice_client_id
     AND te.status IS DISTINCT FROM 'leave'
    WHERE pj.company_id = ${companyId}::UUID
      AND (${clientId}::UUID IS NULL OR pj.practice_client_id = ${clientId}::UUID)
      AND (${jobId}::UUID IS NULL OR pj.id = ${jobId}::UUID)
    GROUP BY pj.id, pc.trading_name, pc.legal_name
  `) as DbRow[];

  return rows.map(mapRow).sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || (b.percentUsed ?? 0) - (a.percentUsed ?? 0)
    || a.title.localeCompare(b.title));
}
