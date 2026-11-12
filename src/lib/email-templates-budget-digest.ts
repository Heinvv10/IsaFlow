/**
 * IsaFlow Email Templates — Budget overspend digest (budgets P5 spec §3d, decision 9).
 * Inline-styled, table-based HTML for email clients, in the practice digest's pattern.
 *
 * Every value that came from the books or a user (company, recipient, account, slice, month, and
 * the link) is HTML-escaped before it is placed, attribute or text. The link is the app's base URL
 * plus the alert's in-app path. Sending is `budgets/overspendDigest.ts`'s, and is OFF unless the
 * company flag AND the server's BUDGET_ALERT_EMAIL_ENABLED=1 are both set.
 */

import { BRAND, emailLayout, ctaButton } from './email-templates-shared';

export interface BudgetDigestAlert {
  accountCode: string;
  accountName: string;
  sliceName: string | null;
  /** 'Apr 2026'. */
  monthLabel: string;
  threshold: number;
  /** Amounts already formatted ('R 1 234.50'). */
  budget: string;
  spent: string;
  /** '112.5%' or the zero-budget wording. */
  pctLabel: string;
  /** In-app path ('/accounting/...'). */
  href: string;
  refired: boolean;
}

export interface BudgetDigestPayload {
  companyName: string;
  recipientName: string;
  alerts: BudgetDigestAlert[];
  appBaseUrl: string;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const cell = (inner: string, extra = '') =>
  `<td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px; color:${BRAND.textBody}; border-bottom:1px solid ${BRAND.borderColor};${extra}">${inner}</td>`;
const head = (label: string, align = 'left') =>
  `<th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em; text-align:${align}; border-bottom:1px solid ${BRAND.borderColor};">${label}</th>`;

function alertRows(alerts: BudgetDigestAlert[], base: string): string {
  return alerts.map((a) => {
    const url = escapeHtml(`${base}${a.href}`);
    const slice = a.sliceName ? `<div style="font-size:11px; color:${BRAND.textMuted}; margin-top:2px;">${escapeHtml(a.sliceName)}</div>` : '';
    const again = a.refired ? ` <span style="font-size:11px; color:${BRAND.textMuted};">(again)</span>` : '';
    return `
      <tr>
        ${cell(`<a href="${url}" style="color:${BRAND.primaryTeal}; text-decoration:none;">${escapeHtml(`${a.accountCode} ${a.accountName}`.trim())}</a>${slice}`)}
        ${cell(escapeHtml(a.monthLabel), ' white-space:nowrap;')}
        ${cell(`${escapeHtml(String(a.threshold))}%${again}`, ' text-align:center; white-space:nowrap;')}
        ${cell(escapeHtml(a.spent), ' text-align:right; white-space:nowrap;')}
        ${cell(escapeHtml(a.budget), ' text-align:right; white-space:nowrap;')}
        ${cell(escapeHtml(a.pctLabel), ' text-align:right; font-weight:bold; color:#be123c; white-space:nowrap;')}
      </tr>`;
  }).join('');
}

export function renderBudgetDigestSubject(payload: BudgetDigestPayload): string {
  const n = payload.alerts.length;
  // A subject is a header, not HTML: strip line breaks so a company name cannot add a header line.
  const company = payload.companyName.replace(/[\r\n]+/g, ' ').trim();
  return `Budget alerts — ${company}: ${n} new overspend alert${n === 1 ? '' : 's'}`;
}

export function renderBudgetDigestHtml(payload: BudgetDigestPayload): string {
  const n = payload.alerts.length;
  const controls = escapeHtml(`${payload.appBaseUrl}/accounting/budgets/controls`);
  const content = `
    <tr>
      <td style="padding:36px 32px 16px;">
        <p style="margin:0 0 6px; font-family:${BRAND.fontStack}; font-size:12px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">
          Budget alerts · ${escapeHtml(payload.companyName)}
        </p>
        <h1 style="margin:0 0 16px; font-family:${BRAND.fontStack}; font-size:22px; font-weight:bold; color:${BRAND.textBody};">
          Hi ${escapeHtml(payload.recipientName)},
        </h1>
        <p style="margin:0; font-family:${BRAND.fontStack}; font-size:14px; color:${BRAND.textSecondary}; line-height:1.6;">
          ${n} budget line${n === 1 ? ' has' : 's have'} passed an alert threshold since the last run. Spent is posted actuals plus open purchase orders.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:0 32px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border:1px solid ${BRAND.borderColor}; border-radius:6px; overflow:hidden; border-collapse:collapse;">
          <thead><tr style="background-color:${BRAND.outerBg};">
            ${head('Account')}${head('Month')}${head('Threshold', 'center')}${head('Spent', 'right')}${head('Budget', 'right')}${head('Of budget', 'right')}
          </tr></thead>
          <tbody>${alertRows(payload.alerts, payload.appBaseUrl)}</tbody>
        </table>
      </td>
    </tr>
    <tr><td style="padding:0 32px 8px;">${ctaButton('Open budget controls', controls)}</td></tr>`;
  return emailLayout(content);
}
