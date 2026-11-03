/**
 * Overspend alerts (budgets P5 spec §3d, decision 9): `evaluateOverspend(companyId, { asOf })`.
 *
 * - Scope: the PRIMARY version of the financial year holding `asOf`, and that year's months from its
 *   first up to `asOf`'s month. Keys are the version's stored budget rows of EXPENSE accounts (each
 *   row is one key at the account's grain: its slice is the row's one dimension, or none at company
 *   grain). Revenue under-run is a report concern (P3), not an alert.
 * - Figures: remaining budget's readers (`remainingForKeys`: the version's amount, P3's one actuals
 *   read, open PO commitments), never a second actuals formula. pct = (actual + committed) / budget
 *   × 100; spend against a zero budget crosses every threshold (`overspendAlertsCore`).
 * - Thresholds: the key's slice override, else its account override, else the company's
 *   `default_thresholds`, else 80/100/120.
 * - Writes (`overspendAlertsWrite`): one `budget_alerts` row per crossing (INSERT ON CONFLICT DO
 *   NOTHING); a resolved crossing crossed again re-fires; an open alert no longer crossed resolves.
 * - Announced: only rows this run inserted or re-fired, and of those only the HIGHEST threshold per
 *   key (account, slice, month); every row is still recorded. Each goes to every owner and admin
 *   (`notifyUsers`, kind 'budget_alert', dedupe key `budget_alert:<alert id>`, or
 *   `budget_alert:<alert id>:<fired_at ms>` for a re-fire), linking to Budget vs Actual on the month
 *   and slice. More than 10 in one run: one summary per user instead (`budget_alert_summary:<asOf>`,
 *   linking to Budget controls). A rerun with unchanged books writes and announces nothing.
 * - Serialised per company: a transaction advisory lock `budget_alerts:<company>` (seed 954) is taken
 *   FIRST, before any read, with the bounded row-lock wait (5 s → `RowLockTimeoutError`, 503 at the
 *   route; the cron records the company as failed and goes on). Two evaluators (the daily run and
 *   Evaluate now) therefore never interleave a resolve and a re-fire.
 * Runs on the caller's connection: app_user under RLS in a request (owner/admin), or the service pool
 * with no claims in the cron. Every statement names the company.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withRowLockBudget, RowLockTimeoutError } from '../core/rowLockBudget';
import { fiscalYearForDate } from '../gl/fiscalYearRegistry';
import { notifyUsers } from '../notifications/userNotificationService';
import { resolvePrimaryVersion } from './budgetVersionScope';
import { readControlSettings, readThresholdOverrides } from './budgetControlSettings';
import { remainingForKeys, type RemainingKey } from './remainingBudget';
import {
  alertHref, crossingsOf, highestPerKey, MAX_ALERT_NOTIFICATIONS_PER_RUN, monthName, pctText, rand, thresholdsFor,
  type AlertKeyFigures,
} from './overspendAlertsCore';
import { insertCrossings, refireResolved, refreshOpen, resolveUncrossed, type AlertRow } from './overspendAlertsWrite';

export interface FiredAlert extends AlertRow {
  accountCode: string;
  accountName: string;
  /** 'CODE Name' of the slice's centre or unit; null at company grain. */
  sliceName: string | null;
  /** True when a resolved alert fired again. */
  refired: boolean;
  href: string;
}

export interface OverspendResult {
  fiscalYear: number;
  /** Null: the year has no primary version (nothing to evaluate; open alerts of its months resolve). */
  versionId: string | null;
  /** Budget keys evaluated (expense rows of the primary version, first month to asOf). */
  keys: number;
  fired: FiredAlert[];
  /** Ids of the alerts this run resolved. */
  resolved: string[];
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const text = (v: unknown): string | null => (v == null ? null : String(v).toLowerCase());

async function lockEvaluation(companyId: string): Promise<void> {
  await withRowLockBudget(
    () => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`budget_alerts:${companyId}`}, 954))`,
    () => new RowLockTimeoutError('The budget alert evaluation'),
  );
}

/** The version's expense budget rows of [first, last] ('YYYY-MM-01'), one key per (account, slice, month). */
async function readExpenseKeys(companyId: string, versionId: string, first: string, last: string): Promise<RemainingKey[]> {
  const rows = (await sql`
    SELECT DISTINCT b.gl_account_id::TEXT AS gl_account_id, b.cc1_id::TEXT AS cc1_id, b.cc2_id::TEXT AS cc2_id,
           b.bu_id::TEXT AS bu_id, to_char(b.month, 'YYYY-MM') AS month
      FROM budget_month_amounts b
      JOIN gl_accounts ga ON ga.id = b.gl_account_id AND ga.company_id = ${companyId}::UUID AND ga.account_type = 'expense'
     WHERE b.company_id = ${companyId}::UUID AND b.version_id = ${versionId}::UUID
       AND b.month BETWEEN ${first}::DATE AND ${last}::DATE
     ORDER BY 1, 5, 2, 3, 4
  `) as DbRow[];
  return rows.map((r) => ({
    glAccountId: String(text(r.gl_account_id)), cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id), month: String(r.month),
  }));
}

/** Owners and admins of the company: the alert recipients (decision 9). */
async function recipients(companyId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT user_id FROM company_users WHERE company_id = ${companyId}::UUID AND role IN ('owner', 'admin') ORDER BY user_id
  `) as DbRow[];
  return rows.map((r) => String(r.user_id));
}

/** Account and slice names for the announced alerts. */
async function named(companyId: string, rows: readonly AlertRow[], refired: ReadonlySet<string>): Promise<FiredAlert[]> {
  if (rows.length === 0) return [];
  const accounts = [...new Set(rows.map((r) => r.glAccountId))];
  const centres = [...new Set(rows.flatMap((r) => [r.cc1Id, r.cc2Id]).filter((v): v is string => v !== null))];
  const units = [...new Set(rows.map((r) => r.buId).filter((v): v is string => v !== null))];
  const acct = new Map(((await sql`
    SELECT id::TEXT AS id, account_code, account_name FROM gl_accounts WHERE company_id = ${companyId}::UUID AND id = ANY(${accounts}::UUID[])
  `) as DbRow[]).map((r) => [String(r.id).toLowerCase(), r]));
  const slice = new Map(((await sql`
    SELECT id::TEXT AS id, code || ' ' || name AS label FROM cost_centres WHERE company_id = ${companyId}::UUID AND id = ANY(${centres}::UUID[])
    UNION ALL
    SELECT id::TEXT, code || ' ' || name FROM business_units WHERE company_id = ${companyId}::UUID AND id = ANY(${units}::UUID[])
  `) as DbRow[]).map((r) => [String(r.id).toLowerCase(), String(r.label)]));
  const out = rows.map((r) => {
    const a = acct.get(r.glAccountId.toLowerCase());
    const member = r.cc1Id ?? r.cc2Id ?? r.buId;
    return {
      ...r,
      accountCode: a ? String(a.account_code) : '',
      accountName: a ? String(a.account_name) : '',
      sliceName: member ? slice.get(member.toLowerCase()) ?? null : null,
      refired: refired.has(r.id),
      href: alertHref(r),
    };
  });
  // Account code, slice, month, threshold: the order the bell and the digest read best in.
  return out.sort((x, y) => x.accountCode.localeCompare(y.accountCode) || (x.sliceName ?? '').localeCompare(y.sliceName ?? '')
    || x.month.localeCompare(y.month) || x.threshold - y.threshold);
}

/** The bell's text for one alert. */
export function alertMessage(a: FiredAlert): { title: string; body: string } {
  const account = `${a.accountCode} ${a.accountName}`.trim();
  const where = `${monthName(a.month)}${a.sliceName ? `, ${a.sliceName}` : ''}`;
  return {
    title: `${account} passed ${a.threshold}% of budget`,
    body: `${where}: actual ${rand(a.actual)} + committed ${rand(a.committed)} = ${rand(a.actual + a.committed)} `
      + `against a budget of ${rand(a.budget)} (${pctText(a.pct)}).${a.refired ? ' It had dropped back below this level and is over again.' : ''}`,
  };
}

/** The page every summary points to. */
export const CONTROLS_HREF = '/accounting/budgets/controls';

/**
 * Notifies owners and admins of this run's fired alerts, less noisily than one per row (every row
 * stays in budget_alerts): per key only the HIGHEST newly crossed threshold; and when that still
 * leaves more than MAX_ALERT_NOTIFICATIONS_PER_RUN, ONE summary per user instead (dedupe key per
 * run date, `budget_alert_summary:<asOf>`). Every recipient gets the same set, so the cap is per user.
 */
async function announce(companyId: string, fired: readonly FiredAlert[], asOf: string): Promise<void> {
  if (fired.length === 0) return;
  const users = await recipients(companyId);
  if (users.length === 0) {
    log.warn('budget alerts: no owner or admin to notify', { companyId, alerts: fired.length }, 'accounting');
    return;
  }
  const alerts = highestPerKey(fired);
  if (alerts.length > MAX_ALERT_NOTIFICATIONS_PER_RUN) {
    await notifyUsers(companyId, users, {
      kind: 'budget_alert', refId: null, href: CONTROLS_HREF, dedupeKey: `budget_alert_summary:${asOf}`,
      title: `${alerts.length} budget lines crossed their thresholds — see Budget controls`,
      body: `${alerts.length} budget lines (account, slice and month) passed an alert threshold in this evaluation. Budget controls lists each one.`,
    });
    return;
  }
  for (const a of alerts) {
    const { title, body } = alertMessage(a);
    const dedupeKey = a.refired ? `budget_alert:${a.id}:${Date.parse(a.firedAt)}` : `budget_alert:${a.id}`;
    await notifyUsers(companyId, users, { kind: 'budget_alert', refId: a.id, title, body, href: a.href, dedupeKey });
  }
}

export async function evaluateOverspend(companyId: string, opts: { asOf: string }): Promise<OverspendResult> {
  if (!DATE.test(opts.asOf)) throw new Error(`evaluateOverspend: asOf must be 'YYYY-MM-DD', got ${JSON.stringify(opts.asOf)}`);
  await lockEvaluation(companyId);
  const fy = await fiscalYearForDate(companyId, opts.asOf);
  const first = `${fy.startDate.slice(0, 7)}-01`;
  const last = `${opts.asOf.slice(0, 7)}-01`;
  const versionId = await resolvePrimaryVersion(companyId, fy.fiscalYear, { create: false });

  let figures: AlertKeyFigures[] = [];
  let keyCount = 0;
  if (versionId !== null) {
    const keys = await readExpenseKeys(companyId, versionId, first, last);
    keyCount = keys.length;
    const results = await remainingForKeys(companyId, keys);
    const v = versionId.toLowerCase();
    // Each key is a stored row at its own grain, so its slice is its own dimensions; a month another
    // registry year's primary owns (a shared month counts in the earlier year) is not this version's.
    figures = results.filter((r) => r.versionId === v).map((r) => ({
      ...r.key, budget: r.budget, actual: r.actual, committed: r.committed,
    }));
  }

  // One connection, one statement at a time (the request's or the cron's transaction).
  const settings = await readControlSettings(companyId);
  const overrides = await readThresholdOverrides(companyId);
  const crossings = crossingsOf(figures, (k) => thresholdsFor(k, overrides, settings.defaultThresholds));

  let inserted: AlertRow[] = [];
  let refired: AlertRow[] = [];
  if (versionId !== null) {
    inserted = await insertCrossings(companyId, versionId, crossings);
    refired = await refireResolved(companyId, versionId, crossings);
    await refreshOpen(companyId, versionId, crossings);
  }
  const resolved = await resolveUncrossed(companyId, versionId, crossings, first, last);

  const fired = await named(companyId, [...inserted, ...refired], new Set(refired.map((r) => r.id)));
  await announce(companyId, fired, opts.asOf);
  log.info('budget alerts evaluated', {
    companyId, asOf: opts.asOf, fiscalYear: fy.fiscalYear, versionId, keys: keyCount, crossings: crossings.length,
    fired: inserted.length, refired: refired.length, resolved: resolved.length,
  }, 'accounting');
  return { fiscalYear: fy.fiscalYear, versionId, keys: keyCount, fired, resolved };
}
