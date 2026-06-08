/**
 * Cross-client work aggregator for the /bureau cockpit.
 *
 * TENANT SAFETY: runs on the RLS-bypassing @/lib/neon pool. Every query MUST
 * filter company_id = ANY(${companyIds}); companyIds is bureau-derived by the
 * caller and is the ONLY company input. Pure shapers drop rows whose
 * company_id is not in the supplied companyMeta map.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { expectedVatPeriodAsOf, type VatAlignment } from './vatPeriodHelper';

export type Severity = 'overdue' | 'due_soon' | 'info';

export interface WorkItem {
  bureauId: string;
  bureauName: string;
  companyId: string;
  companyName: string;
  task: string;
  detail: string;
  dueAt: string | null;
  href: string;
  severity: Severity;
}

export interface CompanyMeta {
  bureau_id: string;
  bureau_name: string;
  company_id: string;
  company_name: string;
}

export interface MonthEndStat {
  closed: number;
  total: number;
}

export interface AggregateResult {
  items: WorkItem[];
  monthEnd: MonthEndStat;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatPeriod(month: number, year: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function endOfNextMonth(periodMonth: number, periodYear: number): Date {
  const nextMonth = periodMonth === 12 ? 1 : periodMonth + 1;
  const nextYear = periodMonth === 12 ? periodYear + 1 : periodYear;
  return new Date(nextYear, nextMonth, 0, 23, 59, 59);
}

export function severityForDate(due: Date, today: Date): Severity {
  const days = (due.getTime() - today.getTime()) / (24 * 3600 * 1000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due_soon';
  return 'info';
}

// ── Payroll signals (moved verbatim from the handler) ───────────────────────

async function payrollSignals(
  companyIds: string[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): Promise<WorkItem[]> {
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

  for (const r of pendingRuns as Array<{ id: string; company_id: string; period_year: number; period_month: number; status: string }>) {
    const m = meta.get(r.company_id);
    if (!m) continue;
    const dueAt = endOfNextMonth(r.period_month, r.period_year);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: `Pay run · ${r.status}`, detail: formatPeriod(r.period_month, r.period_year),
      dueAt: dueAt.toISOString(), href: `/payroll/runs/${r.id}`, severity: severityForDate(dueAt, today),
    });
  }
  for (const r of irp5Issues as Array<{ company_id: string; missing_tax: string | number; missing_id: string | number }>) {
    const m = meta.get(r.company_id);
    if (!m) continue;
    const missingTax = Number(r.missing_tax);
    const missingId = Number(r.missing_id);
    if (missingTax === 0 && missingId === 0) continue;
    const parts: string[] = [];
    if (missingTax > 0) parts.push(`${missingTax} missing tax #`);
    if (missingId > 0) parts.push(`${missingId} missing ID`);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'IRP5 readiness', detail: parts.join(' · '), dueAt: null, href: '/payroll/irp5', severity: 'info',
    });
  }
  for (const r of directives as Array<{ company_id: string; expiring: number }>) {
    const m = meta.get(r.company_id);
    if (!m || r.expiring === 0) continue;
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Tax directive renewal', detail: `${r.expiring} expiring within 30 days`,
      dueAt: inThirtyDays.toISOString(), href: '/payroll/tax-directives', severity: 'due_soon',
    });
  }
  for (const r of leave as Array<{ company_id: string; pending: number }>) {
    const m = meta.get(r.company_id);
    if (!m || r.pending === 0) continue;
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Leave approvals', detail: `${r.pending} pending`, dueAt: null, href: '/payroll/leave', severity: 'info',
    });
  }
  return items;
}

// ── Unreconciled bank transactions signal ────────────────────────────────────

/** Postgres COUNT(*) may arrive as a numeric string over some drivers; the shaper calls Number(). */
export interface UnreconciledRow { company_id: string; cnt: number | string; }

export function shapeUnreconciled(rows: UnreconciledRow[], meta: Map<string, CompanyMeta>): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    const cnt = Number(r.cnt);
    if (!m || cnt === 0) continue;
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Bank reconciliation', detail: `${cnt} unreconciled`, dueAt: null,
      href: '/accounting/reports/bank-transactions', severity: 'info',
    });
  }
  return items;
}

async function unreconciledSignal(companyIds: string[], meta: Map<string, CompanyMeta>): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT company_id, COUNT(*)::int AS cnt
      FROM bank_transactions
     WHERE company_id = ANY(${companyIds})
       AND status NOT IN ('reconciled','matched','excluded')
     GROUP BY company_id
  `) as unknown as UnreconciledRow[];
  return shapeUnreconciled(rows, meta);
}

// ── Bills to approve signal ──────────────────────────────────────────────────

export interface BillsRow { company_id: string; cnt: number | string; earliest_due: string | null; }

export function shapeBillsToApprove(rows: BillsRow[], meta: Map<string, CompanyMeta>, today: Date): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    const cnt = Number(r.cnt);
    if (!m || cnt === 0) continue;
    const due = r.earliest_due ? new Date(`${r.earliest_due}T00:00:00Z`) : null;
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Bills to approve', detail: `${cnt} awaiting approval`,
      dueAt: r.earliest_due, href: '/accounting/reports/ap-aging',
      severity: due ? severityForDate(due, today) : 'info',
    });
  }
  return items;
}

async function billsToApproveSignal(companyIds: string[], meta: Map<string, CompanyMeta>, today: Date): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT company_id, COUNT(*)::int AS cnt, MIN(due_date)::text AS earliest_due
      FROM supplier_invoices
     WHERE company_id = ANY(${companyIds})
       AND status = 'pending_approval'
     GROUP BY company_id
  `) as unknown as BillsRow[];
  return shapeBillsToApprove(rows, meta, today);
}

// ── VAT-due signal ───────────────────────────────────────────────────────────

export interface CompanyVatRow { id: string; vat_period_alignment: string | null; }
export interface VatReturnRow { company_id: string; period_start: string; period_end: string; }

function vatDetail(periodStart: string, periodEnd: string): string {
  const s = new Date(`${periodStart}T00:00:00Z`);
  const e = new Date(`${periodEnd}T00:00:00Z`);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[s.getUTCMonth()]!}–${M[e.getUTCMonth()]!} ${e.getUTCFullYear()}`;
}

export function shapeVatDue(
  companies: CompanyVatRow[],
  returns: VatReturnRow[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const c of companies) {
    const m = meta.get(c.id);
    if (!m) continue;
    const alignment: VatAlignment = c.vat_period_alignment === 'even' ? 'even' : 'odd';
    const period = expectedVatPeriodAsOf(alignment, today);
    const covered = returns.some(
      (r) => r.company_id === c.id && r.period_start <= period.periodStart && r.period_end >= period.periodEnd,
    );
    if (covered) continue;
    const due = new Date(`${period.dueDate}T00:00:00Z`);
    const days = (due.getTime() - today.getTime()) / (24 * 3600 * 1000);
    // VAT filings benefit from a 21-day early-warning window (vs the 7-day default).
    const severity: Severity = days < 0 ? 'overdue' : days <= 21 ? 'due_soon' : 'info';
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: c.id, companyName: m.company_name,
      task: 'VAT return due', detail: vatDetail(period.periodStart, period.periodEnd),
      dueAt: period.dueDate, href: '/accounting/reports/vat-return', severity,
    });
  }
  return items;
}

async function vatDueSignal(companyIds: string[], meta: Map<string, CompanyMeta>, today: Date): Promise<WorkItem[]> {
  const sixMonthsAgo = new Date(today.getTime() - 183 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const companies = (await sql`
    SELECT id, vat_period_alignment
      FROM companies
     WHERE id = ANY(${companyIds})
  `) as unknown as CompanyVatRow[];
  const returns = (await sql`
    SELECT company_id, period_start::text, period_end::text
      FROM vat_returns
     WHERE company_id = ANY(${companyIds})
       AND period_end >= ${sixMonthsAgo}::date
  `) as unknown as VatReturnRow[];
  return shapeVatDue(companies, returns, meta, today);
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/** Runs one signal, degrading to [] on failure so one bad query can't 500 the cockpit. */
async function safeSignal(name: string, fn: () => Promise<WorkItem[]>): Promise<WorkItem[]> {
  try {
    return await fn();
  } catch (err) {
    // Degrade gracefully — the cockpit still renders the other signals.
    log.warn('bureau signal failed', { signal: name, error: err }, 'Bureau');
    return [];
  }
}

export async function aggregateBureauWork(
  companyIds: string[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): Promise<AggregateResult> {
  const groups = await Promise.all([
    safeSignal('payroll', () => payrollSignals(companyIds, meta, today)),
    safeSignal('unreconciled', () => unreconciledSignal(companyIds, meta)),
    safeSignal('bills', () => billsToApproveSignal(companyIds, meta, today)),
    safeSignal('vat', () => vatDueSignal(companyIds, meta, today)),
  ]);
  const items = groups.flat();
  items.sort((a, b) => {
    const order: Record<Severity, number> = { overdue: 0, due_soon: 1, info: 2 };
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    if (!a.dueAt && !b.dueAt) return a.companyName.localeCompare(b.companyName);
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.localeCompare(b.dueAt);
  });
  return { items, monthEnd: { closed: 0, total: meta.size } };
}
