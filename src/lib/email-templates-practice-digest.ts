/**
 * ISAFlow Email Templates — Practice Daily Digest
 * Inline-styled, table-based HTML for email clients.
 */

import { BRAND, emailLayout, ctaButton } from './email-templates-shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DigestTask {
  id: string;
  title: string;
  dueDate: string;       // 'YYYY-MM-DD'
  daysOverdue: number;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  jobTitle: string | null;
  clientName: string | null;
}

export interface DigestPayload {
  recipientName: string;
  overdueTasks: DigestTask[];
  missingTimesheetDate: string | null;  // 'YYYY-MM-DD' or null
  appBaseUrl: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const PRIORITY_LABEL: Record<DigestTask['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const PRIORITY_COLOR: Record<DigestTask['priority'], string> = {
  low: '#94a3b8',
  normal: '#64748b',
  high: '#f59e0b',
  urgent: '#ef4444',
};

function overdueTasksSection(tasks: DigestTask[], appBaseUrl: string): string {
  const rows = tasks.map((t) => {
    const rowBg = t.daysOverdue > 7 ? '#fff1f2' : BRAND.white;
    const client = t.clientName ? esc(t.clientName) : '—';
    const job    = t.jobTitle   ? esc(t.jobTitle)   : '—';
    const prioColor = PRIORITY_COLOR[t.priority];
    const taskUrl = `${appBaseUrl}/accounting/practice/tasks?highlight=${encodeURIComponent(t.id)}`;
    return `
      <tr style="background-color:${rowBg};">
        <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px; color:${BRAND.textBody}; border-bottom:1px solid ${BRAND.borderColor};">
          <a href="${esc(taskUrl)}" style="color:${BRAND.primaryTeal}; text-decoration:none;">${esc(t.title)}</a>
          <div style="font-size:11px; color:${BRAND.textMuted}; margin-top:2px;">${job}</div>
        </td>
        <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px; color:${BRAND.textSecondary}; border-bottom:1px solid ${BRAND.borderColor}; white-space:nowrap;">${client}</td>
        <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px; color:${BRAND.textSecondary}; border-bottom:1px solid ${BRAND.borderColor}; white-space:nowrap;">${esc(t.dueDate)}</td>
        <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px; font-weight:bold; color:#be123c; border-bottom:1px solid ${BRAND.borderColor}; text-align:center; white-space:nowrap;">${t.daysOverdue}d</td>
        <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; font-weight:bold; color:${prioColor}; border-bottom:1px solid ${BRAND.borderColor}; white-space:nowrap; text-transform:uppercase;">${PRIORITY_LABEL[t.priority]}</td>
      </tr>`;
  }).join('');

  return `
    <tr>
      <td style="padding:0 32px 24px;">
        <p style="margin:0 0 10px; font-family:${BRAND.fontStack}; font-size:14px; font-weight:bold; color:${BRAND.textBody};">
          Overdue tasks (${tasks.length})
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border:1px solid ${BRAND.borderColor}; border-radius:6px; overflow:hidden; border-collapse:collapse;">
          <thead>
            <tr style="background-color:${BRAND.outerBg};">
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em; text-align:left; border-bottom:1px solid ${BRAND.borderColor};">Task</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em; text-align:left; border-bottom:1px solid ${BRAND.borderColor};">Client</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em; text-align:left; border-bottom:1px solid ${BRAND.borderColor};">Due</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em; text-align:center; border-bottom:1px solid ${BRAND.borderColor};">Overdue</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em; text-align:left; border-bottom:1px solid ${BRAND.borderColor};">Priority</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </td>
    </tr>`;
}

function missingTimesheetBanner(date: string, appBaseUrl: string): string {
  const submitUrl = `${appBaseUrl}/accounting/practice/time-entry?date=${encodeURIComponent(date)}`;
  return `
    <tr>
      <td style="padding:0 32px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="background-color:#fff7ed; border:1px solid #fed7aa; border-radius:6px;">
          <tr>
            <td style="padding:16px 20px;">
              <p style="margin:0 0 8px; font-family:${BRAND.fontStack}; font-size:14px; font-weight:bold; color:#9a3412;">
                Timesheet not submitted
              </p>
              <p style="margin:0 0 12px; font-family:${BRAND.fontStack}; font-size:13px; color:#c2410c; line-height:1.5;">
                You haven't submitted a timesheet for <strong>${esc(date)}</strong>.
              </p>
              ${ctaButton('Submit Timesheet', submitUrl)}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function renderPracticeDigestSubject(payload: DigestPayload): string {
  const overdueCount = payload.overdueTasks.length;
  const timesheetStatus = payload.missingTimesheetDate ? 'timesheet missing' : 'timesheet ok';
  return `Practice digest — ${overdueCount} overdue, ${timesheetStatus}`;
}

export function renderPracticeDigestHtml(payload: DigestPayload): string {
  const greeting = `
    <tr>
      <td style="padding:36px 32px 24px;">
        <p style="margin:0 0 6px; font-family:${BRAND.fontStack}; font-size:12px;
                  color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">
          Daily Practice Digest
        </p>
        <h1 style="margin:0 0 16px; font-family:${BRAND.fontStack}; font-size:22px;
                   font-weight:bold; color:${BRAND.textBody};">
          Hi ${esc(payload.recipientName)},
        </h1>
        <p style="margin:0; font-family:${BRAND.fontStack}; font-size:14px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          Here's your daily summary of items that need attention.
        </p>
      </td>
    </tr>`;

  const tasksSection = payload.overdueTasks.length > 0
    ? overdueTasksSection(payload.overdueTasks, payload.appBaseUrl)
    : '';

  const timesheetSection = payload.missingTimesheetDate
    ? missingTimesheetBanner(payload.missingTimesheetDate, payload.appBaseUrl)
    : '';

  const content = `${greeting}${tasksSection}${timesheetSection}`;
  return emailLayout(content);
}
