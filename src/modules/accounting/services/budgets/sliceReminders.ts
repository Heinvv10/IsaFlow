/**
 * Budget-holder reminders (budgets P5 spec §3f; P5-6), in-app only. A slice still with its holder
 * ('open' or 'returned') on a DRAFT version, with a due date, reminds each of its holders once per
 * stage: three days before (from three days out until the day before: a missed run still sends it),
 * on the due date, and once overdue. The dedupe key is per slice per stage
 * (`budget_reminder:<slice id>:<stage>`), so a rerun, or the next day's run in the same stage, writes
 * nothing new; a slice submitted (or approved) is no longer reminded.
 *
 * The daily run behind `POST /api/cron/budget-reminders` (timer `scripts/isaflow-budget-reminders.timer`,
 * installed by Hein, never by code) takes each company with something to remind in its OWN
 * transaction on the service pool (`withAlsTransaction`: in production `isaflow_service` →
 * app_service, no claims, 915's mirrors), `app.current_company_id` set, statements bounded at 60 s.
 * One company failing is logged and counted; the run goes on. It can later fold into P5-4's
 * budget-alerts cron (`budgetAlertCron.ts`) as one more step per company.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { todayInSast } from '@/lib/saDateParser';
import { notifyUsers } from '../notifications/userNotificationService';

export type ReminderStage = 'due_soon' | 'due' | 'overdue';

/** Days before the due date the first reminder goes. */
export const REMIND_DAYS_BEFORE = 3;
export const SLICE_REMINDER_CRON_ACTOR = 'system:budget-reminders';
const COMPANY_STATEMENT_TIMEOUT_MS = 60_000;

const dayNumber = (d: string): number => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** The stage a slice due on `dueDate` is in on `today` (both 'YYYY-MM-DD'), or null (not yet). */
export function reminderStage(dueDate: string, today: string): ReminderStage | null {
  const days = dayNumber(dueDate) - dayNumber(today);
  if (days < 0) return 'overdue';
  if (days === 0) return 'due';
  return days <= REMIND_DAYS_BEFORE ? 'due_soon' : null;
}

const TITLE: Record<ReminderStage, string> = {
  due_soon: 'Budget slice due soon',
  due: 'Budget slice due today',
  overdue: 'Budget slice overdue',
};

export interface CompanyReminderRun { companyId: string; ok: boolean; reminded: number; error?: string }

/** One company's reminders as of `today`; returns how many (slice, stage) reminders it asked for. */
export async function evaluateSliceReminders(companyId: string, today: string): Promise<number> {
  const rows = (await sql`
    SELECT r.id::TEXT AS id, r.due_date::TEXT AS due_date, v.name AS version_name, v.fiscal_year,
           CASE WHEN r.cc1_id IS NOT NULL THEN 'CC1 ' || COALESCE(c.code || ' ' || c.name, r.cc1_id::TEXT)
                WHEN r.cc2_id IS NOT NULL THEN 'CC2 ' || COALESCE(c.code || ' ' || c.name, r.cc2_id::TEXT)
                WHEN r.bu_id IS NOT NULL THEN 'BU ' || COALESCE(b.code || ' ' || b.name, r.bu_id::TEXT)
                ELSE 'Company level' END AS label,
           ARRAY(SELECT h.user_id FROM budget_holders h
                  WHERE h.company_id = r.company_id AND h.version_id = r.version_id AND h.cc1_id IS NOT DISTINCT FROM r.cc1_id
                    AND h.cc2_id IS NOT DISTINCT FROM r.cc2_id AND h.bu_id IS NOT DISTINCT FROM r.bu_id ORDER BY h.user_id) AS holders
      FROM budget_slice_reviews r
      JOIN budget_versions v ON v.id = r.version_id AND v.company_id = r.company_id AND v.status = 'draft'
      LEFT JOIN cost_centres c ON c.id = COALESCE(r.cc1_id, r.cc2_id) AND c.company_id = r.company_id
      LEFT JOIN business_units b ON b.id = r.bu_id AND b.company_id = r.company_id
     WHERE r.company_id = ${companyId}::UUID AND r.status IN ('open', 'returned') AND r.due_date IS NOT NULL
       AND r.due_date <= ${today}::DATE + ${REMIND_DAYS_BEFORE}::INT
     ORDER BY r.due_date, r.id
  `) as DbRow[];
  let reminded = 0;
  for (const r of rows) {
    const due = String(r.due_date);
    const stage = reminderStage(due, today);
    const holders = ((r.holders ?? []) as unknown[]).map(String);
    if (stage === null || holders.length === 0) continue;
    await notifyUsers(companyId, holders, {
      kind: 'budget_reminder', refId: String(r.id), href: '/accounting/budgets/review',
      title: `${TITLE[stage]}: ${String(r.label)}`,
      body: `${String(r.version_name)} (FY${String(r.fiscal_year)}), due ${due}. Submit it for review when it is ready.`,
      dedupeKey: `budget_reminder:${String(r.id)}:${stage}`,
    });
    reminded += 1;
  }
  return reminded;
}

async function inServiceTx<T>(companyId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withAlsTransaction({ userId: SLICE_REMINDER_CRON_ACTOR, companyId }, async () => {
    if (companyId) await sql`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    // Tighten only: never loosen a lower server-wide statement_timeout.
    await sql`
      SELECT set_config('statement_timeout', ${String(COMPANY_STATEMENT_TIMEOUT_MS)}::TEXT, true) FROM pg_catalog.pg_settings
       WHERE name = 'statement_timeout' AND (setting::BIGINT = 0 OR setting::BIGINT > ${COMPANY_STATEMENT_TIMEOUT_MS}::BIGINT)
    `;
    return fn();
  });
}

/** Active companies with an open or returned slice of a draft version due within the window. */
export async function loadReminderCompanies(today: string): Promise<string[]> {
  return inServiceTx(undefined, async () => {
    const rows = (await sql`
      SELECT DISTINCT c.id::TEXT AS id FROM companies c
        JOIN budget_slice_reviews r ON r.company_id = c.id
        JOIN budget_versions v ON v.id = r.version_id AND v.company_id = r.company_id AND v.status = 'draft'
       WHERE c.status IS DISTINCT FROM 'suspended' AND c.status IS DISTINCT FROM 'deleted' AND c.suspended_at IS NULL
         AND r.status IN ('open', 'returned') AND r.due_date IS NOT NULL
         AND r.due_date <= ${today}::DATE + ${REMIND_DAYS_BEFORE}::INT
       ORDER BY 1
    `) as DbRow[];
    return rows.map((r) => String(r.id));
  });
}

export interface SliceReminderCronResult { asOf: string; companies: number; failed: number; reminded: number; perCompany: CompanyReminderRun[] }

/** The run over the given companies, one at a time, each in its own transaction. */
export async function runSliceRemindersFor(companies: readonly string[], asOf: string): Promise<SliceReminderCronResult> {
  const perCompany: CompanyReminderRun[] = [];
  for (const companyId of companies) {
    try {
      perCompany.push({ companyId, ok: true, reminded: await inServiceTx(companyId, () => evaluateSliceReminders(companyId, asOf)) });
    } catch (err) {
      log.error('budget reminders: company run failed', {
        companyId, asOf, error: err instanceof Error ? err.message : String(err), code: (err as { code?: unknown })?.code,
      }, 'cron-budget-reminders');
      perCompany.push({ companyId, ok: false, reminded: 0, error: 'reminders failed; see logs' });
    }
  }
  const result = {
    asOf, companies: companies.length, failed: perCompany.filter((r) => !r.ok).length,
    reminded: perCompany.reduce((s, r) => s + r.reminded, 0), perCompany,
  };
  log.info('budget reminders: daily run complete', { asOf, companies: result.companies, failed: result.failed, reminded: result.reminded }, 'cron-budget-reminders');
  return result;
}

export async function runSliceReminderCron(opts: { asOf?: string } = {}): Promise<SliceReminderCronResult> {
  const asOf = opts.asOf ?? todayInSast();
  return runSliceRemindersFor(await loadReminderCompanies(asOf), asOf);
}
