/**
 * Practice Monthly Report Service
 * Sweeps all active companies, assembles report data for the previous calendar
 * month, and emails configured recipients.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import {
  listReportRecipients,
  type ReportRecipient,
} from './practiceReportRecipientsService';
import {
  getStaffUtilisation,
  getClientProfitability,
  getWipAging,
  type UtilisationRow,
} from './practiceReportsService';
import { listCompanyUsers } from './practiceUsersService';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import {
  renderMonthlyReportHtml,
  renderMonthlyReportSubject,
  type MonthlyReportPayload,
} from '@/lib/email-templates-practice-monthly';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MonthlyReportResult {
  companiesProcessed: number;
  recipientsEmailed: number;
  errors: Array<{ companyId: string; email: string; error: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';

interface ReportPeriod {
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
  periodLabel: string; // e.g. "March 2026"
}

/** Derive the period for a given YYYY-MM string. */
function periodFromYearMonth(yearMonth: string): ReportPeriod {
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-based
  const periodStart = `${yearMonth}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)); // Day 0 of next month = last day of this month
  const periodEnd = lastDay.toISOString().split('T')[0]!;
  const periodLabel = lastDay.toLocaleString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { periodStart, periodEnd, periodLabel };
}

/** If no explicit reportMonth, use the previous complete calendar month. */
function previousMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based; month 0 means we need December of previous year
  if (month === 0) {
    return `${year - 1}-12`;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function loadActiveCompanies(): Promise<Array<{ id: string; name: string }>> {
  const rows = (await sql`
    SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name
  `) as DbRow[];
  return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function runMonthlyReports(
  reportMonth?: string,
): Promise<MonthlyReportResult> {
  const result: MonthlyReportResult = {
    companiesProcessed: 0,
    recipientsEmailed: 0,
    errors: [],
  };

  const targetMonth = reportMonth ?? previousMonth();
  const { periodStart, periodEnd, periodLabel } = periodFromYearMonth(targetMonth);

  log.info('Starting monthly practice reports', { targetMonth, periodStart, periodEnd }, 'practiceMonthlyReportService');

  const companies = await loadActiveCompanies();

  for (const company of companies) {
    result.companiesProcessed++;

    let recipients: ReportRecipient[];
    try {
      const all = await listReportRecipients(company.id, true);
      recipients = all.filter((r) => r.reportTypes.includes('monthly_summary'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to load recipients', { companyId: company.id, error: msg }, 'practiceMonthlyReportService');
      result.errors.push({ companyId: company.id, email: '', error: msg });
      continue;
    }

    if (recipients.length === 0) {
      log.info('No active recipients — skipping company', { companyId: company.id }, 'practiceMonthlyReportService');
      continue;
    }

    // Load report data once per company
    let utilisationRows: UtilisationRow[];
    let clientRows: Awaited<ReturnType<typeof getClientProfitability>>;
    let wipRows: Awaited<ReturnType<typeof getWipAging>>;
    let userMap: Map<string, string>;

    try {
      [utilisationRows, clientRows, wipRows] = await Promise.all([
        getStaffUtilisation(company.id, { dateFrom: periodStart, dateTo: periodEnd }),
        getClientProfitability(company.id, { dateFrom: periodStart, dateTo: periodEnd }),
        getWipAging(company.id, { asOfDate: periodEnd }),
      ]);

      const users = await listCompanyUsers(company.id);
      userMap = new Map(users.map((u) => [u.id, u.displayName]));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to load report data', { companyId: company.id, error: msg }, 'practiceMonthlyReportService');
      result.errors.push({ companyId: company.id, email: '', error: msg });
      continue;
    }

    // Aggregate totals
    const totalHours = utilisationRows.reduce((s, r) => s + r.totalHours, 0);
    const billableHours = utilisationRows.reduce((s, r) => s + r.billableHours, 0);
    const billableValue = utilisationRows.reduce((s, r) => s + r.billableValue, 0);
    const utilisationPct = totalHours > 0 ? Math.round((billableHours / totalHours) * 10000) / 100 : 0;
    const wipTotal = wipRows.reduce((s, r) => s + r.total, 0);

    const topClientByRevenue = clientRows[0]
      ? { name: clientRows[0].legalName, revenue: clientRows[0].revenue }
      : null;

    // Top 10 for email size control
    const topClients = clientRows.slice(0, 10).map((r) => ({
      name: r.legalName,
      revenue: r.revenue,
      hours: r.hours,
      marginPct: r.marginPct,
    }));

    const utilisationMapped = utilisationRows
      .sort((a, b) => b.utilisationPct - a.utilisationPct)
      .slice(0, 10)
      .map((r) => ({
        userName: userMap.get(r.userId) ?? r.userId,
        billableHours: r.billableHours,
        utilisationPct: r.utilisationPct,
      }));

    const wipAging = wipRows
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map((r) => ({
        clientName: r.legalName,
        total: r.total,
        bucket31plus: r.bucket31plus,
      }));

    const payload: Omit<MonthlyReportPayload, 'recipientName'> = {
      companyName: company.name,
      periodLabel,
      totals: { totalHours, billableHours, billableValue, utilisationPct, wipTotal, topClient: topClientByRevenue },
      utilisation: utilisationMapped,
      topClients,
      wipAging,
      appBaseUrl: APP_BASE_URL,
    };

    // Send to each recipient independently
    for (const recipient of recipients) {
      try {
        const fullPayload: MonthlyReportPayload = { ...payload, recipientName: recipient.name };
        const subject = renderMonthlyReportSubject(fullPayload);
        const html = renderMonthlyReportHtml(fullPayload);

        const emailResult = await sendEmail({
          to: recipient.email,
          subject,
          html,
          _log: { companyId: company.id, emailType: 'practice_monthly', sentBy: null },
        });

        if (!emailResult.success) {
          result.errors.push({
            companyId: company.id,
            email: recipient.email,
            error: emailResult.error ?? 'Email send failed',
          });
        } else {
          result.recipientsEmailed++;
          log.info('Monthly report sent', { companyId: company.id, email: recipient.email, periodLabel }, 'practiceMonthlyReportService');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to send monthly report', { companyId: company.id, email: recipient.email, error: msg }, 'practiceMonthlyReportService');
        result.errors.push({ companyId: company.id, email: recipient.email, error: msg });
      }
    }
  }

  log.info('Monthly practice reports complete', {
    companiesProcessed: result.companiesProcessed,
    recipientsEmailed: result.recipientsEmailed,
    errors: result.errors.length,
  }, 'practiceMonthlyReportService');

  return result;
}
