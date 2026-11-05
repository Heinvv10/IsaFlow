/**
 * The daily overspend run behind `POST /api/cron/budget-alerts` (budgets P5 spec §3d; timer
 * `scripts/isaflow-budget-alerts.timer`, installed by Hein, never by code).
 *
 * - Companies: active ones (the `loadActiveCompanies` rule of practiceNotificationService: status not
 *   suspended or deleted, `suspended_at` NULL) that hold a primary budget version or an open alert. A
 *   company with neither has nothing to evaluate and gets no "last evaluated" row.
 * - Per company, its OWN transaction on the service pool (`withAlsTransaction`: the pool's login, in
 *   production `isaflow_service` → app_service, no claims, the 915 mirrors; census finding 9), with
 *   `app.current_company_id` set to the company and statements bounded at 120 s: evaluate, record
 *   "last evaluated", plan the email digest; COMMIT. A failure (a lock held past its wait, a bad
 *   row, a timeout) rolls back that company only, is logged and counted, and the run goes on.
 * - After the commit, the digest is sent outside any transaction, each email's email_log row then
 *   written in a short company-context transaction as the cron's role; only with the company flag AND
 *   BUDGET_ALERT_EMAIL_ENABLED=1 (`overspendDigest.ts`); otherwise nothing is sent.
 * - `asOf` defaults to today in South Africa. Budget-holder reminders (P5-6) are not here.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { todayInSast } from '@/lib/saDateParser';
import { recordEvaluated } from './budgetAlertRuns';
import { evaluateOverspend } from './overspendAlerts';
import { planOverspendDigest, sendOverspendDigest, type DigestOutcome, type DigestPlan } from './overspendDigest';

/** The ALS actor of the cron's transactions (no person; nothing it writes stamps a user). */
export const BUDGET_ALERT_CRON_ACTOR = 'system:budget-alerts';
/** One company's evaluation may run this long per statement (tightened only, never loosened). */
const COMPANY_STATEMENT_TIMEOUT_MS = 120_000;

export interface CompanyAlertRun {
  companyId: string;
  ok: boolean;
  fired: number;
  resolved: number;
  digest: DigestOutcome | null;
  /** A fixed phrase (the log holds the detail): exception text can name ids. */
  error?: string;
}

export interface BudgetAlertCronResult {
  asOf: string;
  companies: number;
  failed: number;
  fired: number;
  resolved: number;
  emailsSent: number;
  perCompany: CompanyAlertRun[];
}

async function inServiceTx<T>(companyId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withAlsTransaction({ userId: BUDGET_ALERT_CRON_ACTOR, companyId }, async () => {
    if (companyId) await sql`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    await sql`
      SELECT set_config('statement_timeout', ${String(COMPANY_STATEMENT_TIMEOUT_MS)}::TEXT, true) FROM pg_catalog.pg_settings
       WHERE name = 'statement_timeout' AND (setting::BIGINT = 0 OR setting::BIGINT > ${COMPANY_STATEMENT_TIMEOUT_MS}::BIGINT)
    `;
    return fn();
  });
}

/** Active companies with something to evaluate (a primary budget version or an open alert). */
export async function loadAlertCompanies(): Promise<string[]> {
  return inServiceTx(undefined, async () => {
    const rows = (await sql`
      SELECT c.id::TEXT AS id FROM companies c
       WHERE c.status IS DISTINCT FROM 'suspended' AND c.status IS DISTINCT FROM 'deleted' AND c.suspended_at IS NULL
         AND (EXISTS (SELECT 1 FROM budget_versions v WHERE v.company_id = c.id AND v.is_primary)
              OR EXISTS (SELECT 1 FROM budget_alerts a WHERE a.company_id = c.id AND a.resolved_at IS NULL))
       ORDER BY c.id
    `) as DbRow[];
    return rows.map((r) => String(r.id));
  });
}

async function runCompany(companyId: string, asOf: string): Promise<CompanyAlertRun> {
  let plan: DigestPlan;
  let fired = 0;
  let resolved = 0;
  try {
    plan = await inServiceTx(companyId, async () => {
      const out = await evaluateOverspend(companyId, { asOf });
      fired = out.fired.length;
      resolved = out.resolved.length;
      await recordEvaluated(companyId, { source: 'daily', fired, resolved });
      return planOverspendDigest(companyId, out.fired);
    });
  } catch (err) {
    log.error('budget alerts: company evaluation failed', {
      companyId, asOf, error: err instanceof Error ? err.message : String(err), code: (err as { code?: unknown })?.code,
    }, 'cron-budget-alerts');
    return { companyId, ok: false, fired: 0, resolved: 0, digest: null, error: 'evaluation failed; see logs' };
  }
  // After the commit: each email goes out with NO transaction open (a slow mail server holds no
  // pooled connection); its email_log row is written in a short company-context transaction of its
  // own (same pool and role, company GUC set). Never throws; counts each actual outcome.
  const digest = await sendOverspendDigest(companyId, plan, (write) => inServiceTx(companyId, write));
  return { companyId, ok: true, fired, resolved, digest };
}

export async function runBudgetAlertCron(opts: { asOf?: string } = {}): Promise<BudgetAlertCronResult> {
  return runBudgetAlertsFor(await loadAlertCompanies(), opts.asOf ?? todayInSast());
}

/** The run over the given companies, one at a time, each in its own transaction. */
export async function runBudgetAlertsFor(companies: readonly string[], asOf: string): Promise<BudgetAlertCronResult> {
  const perCompany: CompanyAlertRun[] = [];
  for (const companyId of companies) perCompany.push(await runCompany(companyId, asOf));
  const result: BudgetAlertCronResult = {
    asOf,
    companies: companies.length,
    failed: perCompany.filter((r) => !r.ok).length,
    fired: perCompany.reduce((s, r) => s + r.fired, 0),
    resolved: perCompany.reduce((s, r) => s + r.resolved, 0),
    emailsSent: perCompany.reduce((s, r) => s + (r.digest?.sent ?? 0), 0),
    perCompany,
  };
  log.info('budget alerts: daily run complete', {
    asOf, companies: result.companies, failed: result.failed, fired: result.fired, resolved: result.resolved, emailsSent: result.emailsSent,
  }, 'cron-budget-alerts');
  return result;
}
