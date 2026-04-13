/**
 * Statement Email HTML Template
 * Extracted from statementEmailService to keep file size under 300 lines.
 * Produces a table-based HTML email body for customer account statements.
 */

import { BRAND } from '@/lib/email-templates';

export interface StatementEmailData {
  customerName: string;
  asAtDate: string;
  fromDate: string;
  companyName: string;
  message?: string;
  summary: {
    totalInvoiced: number;
    totalPaid: number;
    totalCredits: number;
    balance: number;
  };
  transactions: Array<{
    date: string;
    type: 'invoice' | 'payment' | 'credit_note';
    reference: string;
    debit: number;
    credit: number;
    balance: number;
  }>;
}

const fmtZAR = (n: number): string =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtDate = (d: string): string => {
  const parts = d.split('T')[0]?.split('-') ?? [];
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
};

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit Note',
};

function buildTxnRows(
  transactions: StatementEmailData['transactions'],
  fromDate: string
): string {
  const filtered = transactions.filter(t => t.date >= fromDate);
  if (filtered.length === 0) {
    return '<tr><td colspan="6" style="padding:12px;text-align:center;color:#94a3b8;font-size:12px;">No transactions in this period</td></tr>';
  }
  return filtered.map(t => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;">${fmtDate(t.date)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;">${TYPE_LABELS[t.type] ?? t.type}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escHtml(t.reference)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;">${t.debit > 0 ? fmtZAR(t.debit) : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;">${t.credit > 0 ? fmtZAR(t.credit) : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;font-weight:bold;">${fmtZAR(t.balance)}</td>
    </tr>`).join('');
}

export function buildStatementEmailHtml(data: StatementEmailData): string {
  const { summary } = data;
  const balanceColor = summary.balance > 0 ? '#dc2626' : '#16a34a';
  const customMsg = data.message
    ? `<p style="font-size:14px;color:#1e293b;margin:0 0 16px;">${escHtml(data.message)}</p>`
    : '';
  const txnRows = buildTxnRows(data.transactions, data.fromDate);

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:${BRAND.outerBg};font-family:${BRAND.fontStack};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.outerBg};padding:24px 0;">
<tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0"
         style="background:#fff;border-radius:8px;overflow:hidden;border:1px solid ${BRAND.borderColor};">
    <tr><td style="background:${BRAND.darkBg};padding:24px 32px;border-bottom:3px solid ${BRAND.primaryTeal};">
      <span style="color:#fff;font-size:22px;font-weight:bold;">STATEMENT</span>
      ${data.companyName ? `<span style="color:${BRAND.primaryTeal};font-size:14px;margin-left:12px;">${escHtml(data.companyName)}</span>` : ''}
    </td></tr>
    <tr><td style="padding:24px 32px;">
      <p style="font-size:16px;font-weight:bold;color:#1e293b;margin:0 0 4px;">
        Dear ${escHtml(data.customerName)},
      </p>
      <p style="font-size:14px;color:#64748b;margin:0 0 16px;">
        Please find your account statement as at ${fmtDate(data.asAtDate)} below.
      </p>
      ${customMsg}
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:12px;text-align:center;width:25%;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;">Invoiced</div>
            <div style="font-size:16px;font-weight:bold;color:#1e293b;">${fmtZAR(summary.totalInvoiced)}</div>
          </td>
          <td style="width:4px;"></td>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:12px;text-align:center;width:25%;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;">Paid</div>
            <div style="font-size:16px;font-weight:bold;color:#16a34a;">${fmtZAR(summary.totalPaid)}</div>
          </td>
          <td style="width:4px;"></td>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:12px;text-align:center;width:25%;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;">Credits</div>
            <div style="font-size:16px;font-weight:bold;color:#0891b2;">${fmtZAR(summary.totalCredits)}</div>
          </td>
          <td style="width:4px;"></td>
          <td style="background:#fef2f2;border:1px solid #fecaca;border-radius:4px;padding:12px;text-align:center;width:25%;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;">Balance Due</div>
            <div style="font-size:16px;font-weight:bold;color:${balanceColor};">${fmtZAR(summary.balance)}</div>
          </td>
        </tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <thead>
          <tr style="background:#1a3a6b;">
            <th style="padding:8px;text-align:left;font-size:11px;color:#fff;font-weight:600;">Date</th>
            <th style="padding:8px;text-align:left;font-size:11px;color:#fff;font-weight:600;">Type</th>
            <th style="padding:8px;text-align:left;font-size:11px;color:#fff;font-weight:600;">Reference</th>
            <th style="padding:8px;text-align:right;font-size:11px;color:#fff;font-weight:600;">Debit</th>
            <th style="padding:8px;text-align:right;font-size:11px;color:#fff;font-weight:600;">Credit</th>
            <th style="padding:8px;text-align:right;font-size:11px;color:#fff;font-weight:600;">Balance</th>
          </tr>
        </thead>
        <tbody>${txnRows}</tbody>
      </table>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
      <p style="font-size:12px;color:#94a3b8;margin:0;">
        ISAFlow &mdash; South African Cloud Accounting &nbsp;|&nbsp;
        This is an automated statement. Please do not reply to this email.
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}
