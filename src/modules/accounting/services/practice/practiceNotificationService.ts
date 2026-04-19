/**
 * Practice Notification Service
 * Sends daily digest emails: overdue tasks + missing timesheet per assignee.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { listCompanyUsers } from './practiceUsersService';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import {
  renderPracticeDigestHtml,
  renderPracticeDigestSubject,
  type DigestTask,
  type DigestPayload,
} from '@/lib/email-templates-practice-digest';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DailyDigestResult {
  companiesProcessed: number;
  recipientsNotified: number;
  recipientsSkipped: number;
  errors: Array<{ companyId: string; userId: string; error: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';

async function loadActiveCompanies(): Promise<string[]> {
  const rows = (await sql`
    SELECT id FROM companies WHERE deleted_at IS NULL
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/** yesterday = today minus 1 day, YYYY-MM-DD in UTC (SAST = UTC+2, close enough for daily cron) */
function getYesterday(): string {
  return new Date(Date.now() - 86400000).toISOString().split('T')[0]!;
}

/** Returns 0=Sun … 6=Sat for a YYYY-MM-DD date string (UTC). */
function dayOfWeekUtc(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function isWeekday(dateStr: string): boolean {
  const dow = dayOfWeekUtc(dateStr);
  return dow >= 1 && dow <= 5; // Mon–Fri
}

async function queryOverdueTasks(
  companyId: string,
  userId: string,
): Promise<DigestTask[]> {
  const rows = (await sql`
    SELECT t.id, t.title, t.due_date, t.priority,
           pj.title AS job_title,
           pc.legal_name AS client_name,
           GREATEST(0, (CURRENT_DATE - t.due_date)::INT) AS days_overdue
    FROM practice_tasks t
    LEFT JOIN practice_jobs pj ON pj.id = t.job_id
    LEFT JOIN practice_clients pc ON pc.id = pj.practice_client_id
    WHERE t.company_id = ${companyId}::UUID
      AND t.assigned_to = ${userId}::UUID
      AND t.status IN ('pending', 'in_progress')
      AND t.due_date < CURRENT_DATE
    ORDER BY t.due_date ASC
    LIMIT 20
  `) as DbRow[];

  return rows.map((r): DigestTask => ({
    id: String(r.id),
    title: String(r.title),
    dueDate: r.due_date instanceof Date
      ? r.due_date.toISOString().split('T')[0]!
      : String(r.due_date),
    daysOverdue: Number(r.days_overdue),
    priority: (r.priority as DigestTask['priority']) ?? 'normal',
    jobTitle: r.job_title ? String(r.job_title) : null,
    clientName: r.client_name ? String(r.client_name) : null,
  }));
}

async function hasTimesheetForDate(
  companyId: string,
  userId: string,
  date: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM time_entries
    WHERE company_id = ${companyId}::UUID
      AND user_id = ${userId}::UUID
      AND entry_date = ${date}::DATE
      AND status <> 'draft'
      AND practice_client_id IS NOT NULL
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function runDailyDigest(): Promise<DailyDigestResult> {
  const result: DailyDigestResult = {
    companiesProcessed: 0,
    recipientsNotified: 0,
    recipientsSkipped: 0,
    errors: [],
  };

  const companies = await loadActiveCompanies();
  const yesterday = getYesterday();
  const yesterdayIsWeekday = isWeekday(yesterday);

  for (const companyId of companies) {
    result.companiesProcessed++;

    let users;
    try {
      users = await listCompanyUsers(companyId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to list company users', { companyId, error: msg }, 'practiceNotificationService');
      result.errors.push({ companyId, userId: '', error: msg });
      continue;
    }

    for (const user of users) {
      try {
        const overdueTasks = await queryOverdueTasks(companyId, user.id);

        let missingTimesheetDate: string | null = null;
        if (yesterdayIsWeekday) {
          const submitted = await hasTimesheetForDate(companyId, user.id, yesterday);
          if (!submitted) {
            missingTimesheetDate = yesterday;
          }
        }

        if (overdueTasks.length === 0 && missingTimesheetDate === null) {
          result.recipientsSkipped++;
          continue;
        }

        const payload: DigestPayload = {
          recipientName: user.displayName,
          overdueTasks,
          missingTimesheetDate,
          appBaseUrl: APP_BASE_URL,
        };

        const subject = renderPracticeDigestSubject(payload);
        const html = renderPracticeDigestHtml(payload);

        const emailResult = await sendEmail({
          to: user.email,
          subject,
          html,
          _log: { companyId, emailType: 'practice_digest', sentBy: null },
        });

        if (!emailResult.success) {
          result.errors.push({
            companyId,
            userId: user.id,
            error: emailResult.error ?? 'Email send failed',
          });
        }

        result.recipientsNotified++;
        log.info('Practice digest sent', {
          companyId,
          userId: user.id,
          overdue: overdueTasks.length,
          missingTimesheet: missingTimesheetDate !== null,
        }, 'practiceNotificationService');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to process user digest', { companyId, userId: user.id, error: msg }, 'practiceNotificationService');
        result.errors.push({ companyId, userId: user.id, error: msg });
      }
    }
  }

  log.info('Daily digest complete', {
    companiesProcessed: result.companiesProcessed,
    recipientsNotified: result.recipientsNotified,
    recipientsSkipped: result.recipientsSkipped,
    errors: result.errors.length,
  }, 'practiceNotificationService');

  return result;
}
