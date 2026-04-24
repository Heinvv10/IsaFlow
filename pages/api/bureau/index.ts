/**
 * GET /api/bureau
 *
 * Returns the bureaus the current user belongs to + the work-owed-today
 * aggregator across all client companies in those bureaus.
 *
 * Auth: any logged-in user. Users whose account_type='direct' get an empty
 * payload — the page redirects them away.
 */

import type { NextApiResponse } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { listBureausForUser } from '@/modules/bureau/services/bureauService';

interface WorkItem {
  bureauId: string;
  bureauName: string;
  companyId: string;
  companyName: string;
  task: string;
  detail: string;
  dueAt: string | null;
  href: string;
  severity: 'overdue' | 'due_soon' | 'info';
}

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const userId = req.user.id;
  const bureaus = await listBureausForUser(userId);

  if (bureaus.length === 0) {
    return apiResponse.success(res, { bureaus: [], workItems: [], stats: zeroStats() });
  }

  const bureauIds = bureaus.map((b) => b.id);

  // All client companies under any of the user's bureaus, with bureau context.
  const companyRows = (await sql`
    SELECT bc.bureau_id, b.name AS bureau_name,
           bc.company_id, c.name AS company_name
      FROM bureau_companies bc
      JOIN bureaus b ON b.id = bc.bureau_id
      JOIN companies c ON c.id = bc.company_id
     WHERE bc.bureau_id = ANY(${bureauIds})
     ORDER BY b.name, c.name
  `) as unknown as Array<{ bureau_id: string; bureau_name: string; company_id: string; company_name: string }>;

  if (companyRows.length === 0) {
    return apiResponse.success(res, {
      bureaus,
      workItems: [],
      stats: zeroStats(),
      companyCount: 0,
    });
  }

  const companyIds = companyRows.map((r) => r.company_id);
  const companyMeta = new Map(companyRows.map((r) => [r.company_id, r]));

  // ─── Pull source signals in parallel — keep each query self-contained ────
  // 1. Pay runs in draft/calculated/approved (not yet posted) — deadline = end of next month.
  //    2. IRP5 readiness — flagged when an employee has payroll but no tax number.
  //    3. EMP201 — implied "due" when a posted run for the period exists but
  //       no header row marks it as filed yet (header.filed_at is null).
  //    4. Tax directives expiring in the next 30 days.
  //    5. Pending leave requests.

  const today = new Date();
  const inThirtyDays = new Date(today.getTime() + 30 * 24 * 3600 * 1000);

  const [pendingRuns, irp5Issues, directives, leave] = await Promise.all([
    sql`
      SELECT pr.id, pr.company_id, pr.period_year, pr.period_month, pr.status
        FROM payroll_run_headers pr
       WHERE pr.company_id = ANY(${companyIds})
         AND pr.status IN ('draft','calculated','approved')
       ORDER BY pr.period_year, pr.period_month
    `,
    sql`
      SELECT pe.company_id, COUNT(*) FILTER (WHERE pe.tax_number IS NULL) AS missing_tax,
                            COUNT(*) FILTER (WHERE pe.id_number IS NULL)  AS missing_id
        FROM payroll_employees pe
       WHERE pe.company_id = ANY(${companyIds})
         AND pe.end_date IS NULL
       GROUP BY pe.company_id
    `,
    sql`
      SELECT td.company_id, COUNT(*)::int AS expiring
        FROM tax_directives td
       WHERE td.company_id = ANY(${companyIds})
         AND td.expiry_date IS NOT NULL
         AND td.expiry_date <= ${inThirtyDays.toISOString().slice(0, 10)}::date
         AND td.expiry_date >= ${today.toISOString().slice(0, 10)}::date
       GROUP BY td.company_id
    `,
    sql`
      SELECT plr.company_id, COUNT(*)::int AS pending
        FROM payroll_leave_requests plr
       WHERE plr.company_id = ANY(${companyIds})
         AND plr.status = 'pending'
       GROUP BY plr.company_id
    `,
  ]);

  const items: WorkItem[] = [];

  // Pay run rows
  for (const r of pendingRuns as Array<{ id: string; company_id: string; period_year: number; period_month: number; status: string }>) {
    const meta = companyMeta.get(r.company_id);
    if (!meta) continue;
    const periodLabel = formatPeriod(r.period_month, r.period_year);
    const dueAt = endOfNextMonth(r.period_month, r.period_year);
    const severity = severityForDate(dueAt, today);
    items.push({
      bureauId: meta.bureau_id,
      bureauName: meta.bureau_name,
      companyId: r.company_id,
      companyName: meta.company_name,
      task: `Pay run · ${r.status}`,
      detail: periodLabel,
      dueAt: dueAt.toISOString(),
      href: `/payroll/runs/${r.id}`,
      severity,
    });
  }

  // IRP5 readiness rows
  for (const r of irp5Issues as Array<{ company_id: string; missing_tax: string | number; missing_id: string | number }>) {
    const meta = companyMeta.get(r.company_id);
    if (!meta) continue;
    const missingTax = Number(r.missing_tax);
    const missingId = Number(r.missing_id);
    if (missingTax === 0 && missingId === 0) continue;
    const parts = [];
    if (missingTax > 0) parts.push(`${missingTax} missing tax #`);
    if (missingId > 0) parts.push(`${missingId} missing ID`);
    items.push({
      bureauId: meta.bureau_id,
      bureauName: meta.bureau_name,
      companyId: r.company_id,
      companyName: meta.company_name,
      task: 'IRP5 readiness',
      detail: parts.join(' · '),
      dueAt: null,
      href: '/payroll/irp5',
      severity: 'info',
    });
  }

  // Tax directive renewals
  for (const r of directives as Array<{ company_id: string; expiring: number }>) {
    const meta = companyMeta.get(r.company_id);
    if (!meta || r.expiring === 0) continue;
    items.push({
      bureauId: meta.bureau_id,
      bureauName: meta.bureau_name,
      companyId: r.company_id,
      companyName: meta.company_name,
      task: 'Tax directive renewal',
      detail: `${r.expiring} expiring within 30 days`,
      dueAt: inThirtyDays.toISOString(),
      href: '/payroll/tax-directives',
      severity: 'due_soon',
    });
  }

  // Pending leave approvals
  for (const r of leave as Array<{ company_id: string; pending: number }>) {
    const meta = companyMeta.get(r.company_id);
    if (!meta || r.pending === 0) continue;
    items.push({
      bureauId: meta.bureau_id,
      bureauName: meta.bureau_name,
      companyId: r.company_id,
      companyName: meta.company_name,
      task: 'Leave approvals',
      detail: `${r.pending} pending`,
      dueAt: null,
      href: '/payroll/leave',
      severity: 'info',
    });
  }

  items.sort((a, b) => {
    const sevOrder: Record<WorkItem['severity'], number> = { overdue: 0, due_soon: 1, info: 2 };
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    if (!a.dueAt && !b.dueAt) return a.companyName.localeCompare(b.companyName);
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.localeCompare(b.dueAt);
  });

  const stats = {
    overdue: items.filter((i) => i.severity === 'overdue').length,
    dueSoon: items.filter((i) => i.severity === 'due_soon').length,
    info: items.filter((i) => i.severity === 'info').length,
    total: items.length,
  };

  return apiResponse.success(res, {
    bureaus,
    workItems: items,
    stats,
    companyCount: companyRows.length,
  });
}

function formatPeriod(month: number, year: number): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[month - 1]} ${year}`;
}

function endOfNextMonth(periodMonth: number, periodYear: number): Date {
  // Filing deadline is end of the month following the period.
  const nextMonth = periodMonth === 12 ? 1 : periodMonth + 1;
  const nextYear = periodMonth === 12 ? periodYear + 1 : periodYear;
  return new Date(nextYear, nextMonth, 0, 23, 59, 59); // day 0 of month+1 = last day of nextMonth
}

function severityForDate(due: Date, today: Date): WorkItem['severity'] {
  const ms = due.getTime() - today.getTime();
  const days = ms / (24 * 3600 * 1000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due_soon';
  return 'info';
}

function zeroStats() {
  return { overdue: 0, dueSoon: 0, info: 0, total: 0 };
}

export default withUserAuth(withErrorHandler(handler));
