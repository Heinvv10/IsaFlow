/**
 * ISAFlow Email Templates — Monthly Practice Management Report
 * Inline-styled, table-based HTML for email clients.
 */

import { BRAND, emailLayout, ctaButton } from './email-templates-shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MonthlyReportPayload {
  recipientName: string | null;
  companyName: string;
  periodLabel: string;   // e.g. "March 2026"
  totals: {
    totalHours: number;
    billableHours: number;
    billableValue: number;
    utilisationPct: number;
    wipTotal: number;
    topClient: { name: string; revenue: number } | null;
  };
  utilisation: Array<{ userName: string; billableHours: number; utilisationPct: number }>;
  topClients: Array<{ name: string; revenue: number; hours: number; marginPct: number | null }>;
  wipAging: Array<{ clientName: string; total: number; bucket31plus: number }>;
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

function fmtCurrency(n: number): string {
  return `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtHours(n: number): string {
  return `${n.toFixed(1)}h`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

// ─── KPI Grid ─────────────────────────────────────────────────────────────────

function kpiGrid(totals: MonthlyReportPayload['totals']): string {
  const cards = [
    { label: 'Total Hours', value: fmtHours(totals.totalHours) },
    { label: 'Billable Value', value: fmtCurrency(totals.billableValue) },
    { label: 'Utilisation', value: fmtPct(totals.utilisationPct) },
    { label: 'WIP Outstanding', value: fmtCurrency(totals.wipTotal) },
  ];

  const cardHtml = cards.map((c) => `
    <td style="width:25%; padding:0 6px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
             style="background-color:${BRAND.outerBg}; border:1px solid ${BRAND.borderColor};
                    border-radius:6px; border-collapse:collapse;">
        <tr>
          <td style="padding:14px 16px; text-align:center;">
            <div style="font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                        text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">
              ${esc(c.label)}
            </div>
            <div style="font-family:${BRAND.fontStack}; font-size:20px; font-weight:bold;
                        color:${BRAND.textBody}; line-height:1.2;">
              ${esc(c.value)}
            </div>
          </td>
        </tr>
      </table>
    </td>`).join('');

  return `
    <tr>
      <td style="padding:0 32px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr>${cardHtml}</tr>
        </table>
      </td>
    </tr>`;
}

// ─── Staff Utilisation Section ─────────────────────────────────────────────

function utilisationSection(rows: MonthlyReportPayload['utilisation']): string {
  if (rows.length === 0) return '';
  const top5 = rows.slice(0, 5);
  const trs = top5.map((r) => `
    <tr>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px;
                 color:${BRAND.textBody}; border-bottom:1px solid ${BRAND.borderColor};">
        ${esc(r.userName)}
      </td>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px;
                 color:${BRAND.textSecondary}; border-bottom:1px solid ${BRAND.borderColor};
                 text-align:right; white-space:nowrap;">
        ${fmtHours(r.billableHours)}
      </td>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px; font-weight:bold;
                 color:${r.utilisationPct >= 75 ? '#16a34a' : r.utilisationPct >= 50 ? '#ca8a04' : '#dc2626'};
                 border-bottom:1px solid ${BRAND.borderColor}; text-align:right; white-space:nowrap;">
        ${fmtPct(r.utilisationPct)}
      </td>
    </tr>`).join('');

  return `
    <tr>
      <td style="padding:0 32px 24px;">
        <p style="margin:0 0 10px; font-family:${BRAND.fontStack}; font-size:14px; font-weight:bold;
                  color:${BRAND.textBody};">Top Staff Utilisation</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border:1px solid ${BRAND.borderColor}; border-radius:6px; border-collapse:collapse; overflow:hidden;">
          <thead>
            <tr style="background-color:${BRAND.outerBg};">
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:left; border-bottom:1px solid ${BRAND.borderColor};">Staff Member</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:right; border-bottom:1px solid ${BRAND.borderColor};">Billable Hours</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:right; border-bottom:1px solid ${BRAND.borderColor};">Utilisation</th>
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </td>
    </tr>`;
}

// ─── Top Clients Section ──────────────────────────────────────────────────────

function topClientsSection(rows: MonthlyReportPayload['topClients']): string {
  if (rows.length === 0) return '';
  const top5 = rows.slice(0, 5);
  const trs = top5.map((r) => `
    <tr>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px;
                 color:${BRAND.textBody}; border-bottom:1px solid ${BRAND.borderColor};">
        ${esc(r.name)}
      </td>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px;
                 color:${BRAND.textSecondary}; border-bottom:1px solid ${BRAND.borderColor};
                 text-align:right; white-space:nowrap;">
        ${fmtCurrency(r.revenue)}
      </td>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px;
                 color:${BRAND.textSecondary}; border-bottom:1px solid ${BRAND.borderColor};
                 text-align:right; white-space:nowrap;">
        ${fmtHours(r.hours)}
      </td>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px;
                 color:${BRAND.textSecondary}; border-bottom:1px solid ${BRAND.borderColor};
                 text-align:right; white-space:nowrap;">
        ${r.marginPct !== null ? fmtPct(r.marginPct) : '—'}
      </td>
    </tr>`).join('');

  return `
    <tr>
      <td style="padding:0 32px 24px;">
        <p style="margin:0 0 10px; font-family:${BRAND.fontStack}; font-size:14px; font-weight:bold;
                  color:${BRAND.textBody};">Top Clients by Revenue</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border:1px solid ${BRAND.borderColor}; border-radius:6px; border-collapse:collapse; overflow:hidden;">
          <thead>
            <tr style="background-color:${BRAND.outerBg};">
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:left; border-bottom:1px solid ${BRAND.borderColor};">Client</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:right; border-bottom:1px solid ${BRAND.borderColor};">Revenue</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:right; border-bottom:1px solid ${BRAND.borderColor};">Hours</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:right; border-bottom:1px solid ${BRAND.borderColor};">Margin</th>
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </td>
    </tr>`;
}

// ─── WIP Aging Section ────────────────────────────────────────────────────────

function wipAgingSection(rows: MonthlyReportPayload['wipAging']): string {
  const aged = rows.filter((r) => r.bucket31plus > 0).slice(0, 5);
  if (aged.length === 0) return '';
  const trs = aged.map((r) => `
    <tr>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px;
                 color:${BRAND.textBody}; border-bottom:1px solid ${BRAND.borderColor};">
        ${esc(r.clientName)}
      </td>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px;
                 color:${BRAND.textSecondary}; border-bottom:1px solid ${BRAND.borderColor};
                 text-align:right; white-space:nowrap;">
        ${fmtCurrency(r.total)}
      </td>
      <td style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:13px; font-weight:bold;
                 color:#dc2626; border-bottom:1px solid ${BRAND.borderColor};
                 text-align:right; white-space:nowrap;">
        ${fmtCurrency(r.bucket31plus)}
      </td>
    </tr>`).join('');

  return `
    <tr>
      <td style="padding:0 32px 24px;">
        <p style="margin:0 0 10px; font-family:${BRAND.fontStack}; font-size:14px; font-weight:bold;
                  color:${BRAND.textBody};">WIP Aging — Clients with 31+ Day Balances</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border:1px solid ${BRAND.borderColor}; border-radius:6px; border-collapse:collapse; overflow:hidden;">
          <thead>
            <tr style="background-color:${BRAND.outerBg};">
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:left; border-bottom:1px solid ${BRAND.borderColor};">Client</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:right; border-bottom:1px solid ${BRAND.borderColor};">Total WIP</th>
              <th style="padding:8px 10px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};
                         text-transform:uppercase; letter-spacing:0.05em; text-align:right; border-bottom:1px solid ${BRAND.borderColor};">31+ Days</th>
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </td>
    </tr>`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function renderMonthlyReportSubject(payload: MonthlyReportPayload): string {
  return `Monthly Practice Report — ${payload.companyName}, ${payload.periodLabel}`;
}

export function renderMonthlyReportHtml(payload: MonthlyReportPayload): string {
  const reportUrl =
    `${payload.appBaseUrl}/accounting/practice/reports/utilisation` +
    `?dateFrom=${encodeURIComponent(payload.periodLabel.replace(' ', '-'))}`;

  const greeting = `
    <tr>
      <td style="padding:36px 32px 24px;">
        <p style="margin:0 0 6px; font-family:${BRAND.fontStack}; font-size:12px;
                  color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">
          Practice Report — ${esc(payload.periodLabel)}
        </p>
        <h1 style="margin:0 0 16px; font-family:${BRAND.fontStack}; font-size:22px;
                   font-weight:bold; color:${BRAND.textBody};">
          ${payload.recipientName ? `Hi ${esc(payload.recipientName)},` : 'Practice Report'}
        </h1>
        <p style="margin:0; font-family:${BRAND.fontStack}; font-size:14px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          Here is the monthly practice summary for <strong>${esc(payload.companyName)}</strong>
          for <strong>${esc(payload.periodLabel)}</strong>.
        </p>
      </td>
    </tr>`;

  const cta = `
    <tr>
      <td style="padding:0 32px 24px;">
        ${ctaButton('View Full Report', reportUrl)}
      </td>
    </tr>`;

  const content = `
    ${greeting}
    ${kpiGrid(payload.totals)}
    ${utilisationSection(payload.utilisation)}
    ${topClientsSection(payload.topClients)}
    ${wipAgingSection(payload.wipAging)}
    ${cta}`;

  return emailLayout(content);
}
