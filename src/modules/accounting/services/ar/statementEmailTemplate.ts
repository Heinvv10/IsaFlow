/**
 * Statement Email HTML Template
 * Wraps the statement body in the shared emailLayout so statements share the
 * same header/footer as every other transactional email.
 */

import { BRAND, emailLayout } from '@/lib/email-templates';

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
    return `<tr><td colspan="6" style="padding:12px; text-align:center; color:${BRAND.textMuted}; font-size:12px; font-family:${BRAND.fontStack};">No transactions in this period</td></tr>`;
  }
  return filtered.map(t => `
    <tr>
      <td style="padding:6px 8px; border-bottom:1px solid ${BRAND.borderColor}; font-size:12px; font-family:${BRAND.fontStack}; color:${BRAND.textBody};">${fmtDate(t.date)}</td>
      <td style="padding:6px 8px; border-bottom:1px solid ${BRAND.borderColor}; font-size:12px; font-family:${BRAND.fontStack}; color:${BRAND.textBody};">${TYPE_LABELS[t.type] ?? t.type}</td>
      <td style="padding:6px 8px; border-bottom:1px solid ${BRAND.borderColor}; font-size:12px; font-family:${BRAND.fontStack}; color:${BRAND.textBody};">${escHtml(t.reference)}</td>
      <td style="padding:6px 8px; border-bottom:1px solid ${BRAND.borderColor}; font-size:12px; font-family:${BRAND.fontStack}; color:${BRAND.textBody}; text-align:right;">${t.debit > 0 ? fmtZAR(t.debit) : ''}</td>
      <td style="padding:6px 8px; border-bottom:1px solid ${BRAND.borderColor}; font-size:12px; font-family:${BRAND.fontStack}; color:${BRAND.textBody}; text-align:right;">${t.credit > 0 ? fmtZAR(t.credit) : ''}</td>
      <td style="padding:6px 8px; border-bottom:1px solid ${BRAND.borderColor}; font-size:12px; font-family:${BRAND.fontStack}; color:${BRAND.textBody}; text-align:right; font-weight:bold;">${fmtZAR(t.balance)}</td>
    </tr>`).join('');
}

export function buildStatementEmailHtml(data: StatementEmailData): string {
  const { summary } = data;
  const balanceColor = summary.balance > 0 ? '#dc2626' : '#16a34a';
  const customMsg = data.message
    ? `<p style="font-family:${BRAND.fontStack}; font-size:14px; color:${BRAND.textBody}; margin:0 0 16px;">${escHtml(data.message)}</p>`
    : '';
  const txnRows = buildTxnRows(data.transactions, data.fromDate);

  const content = `
    <tr>
      <td style="padding:36px 32px 28px;">
        <p style="margin:0 0 6px; font-family:${BRAND.fontStack}; font-size:12px;
                  color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">
          Account Statement
        </p>
        <h1 style="margin:0 0 8px; font-family:${BRAND.fontStack}; font-size:24px;
                   font-weight:bold; color:${BRAND.textBody};">
          ${escHtml(data.companyName || 'ISAFlow')}
        </h1>
        <p style="margin:0 0 24px; font-family:${BRAND.fontStack}; font-size:15px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          Dear <strong style="color:${BRAND.textBody};">${escHtml(data.customerName)}</strong>,<br>
          please find your account statement as at
          <strong style="color:${BRAND.textBody};">${fmtDate(data.asAtDate)}</strong> below.
        </p>
        ${customMsg}
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-bottom:24px;">
          <tr>
            <td style="background:${BRAND.outerBg}; border:1px solid ${BRAND.borderColor}; border-radius:6px; padding:12px; text-align:center; width:25%;">
              <div style="font-family:${BRAND.fontStack}; font-size:10px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Invoiced</div>
              <div style="font-family:${BRAND.fontStack}; font-size:16px; font-weight:bold; color:${BRAND.textBody}; margin-top:4px;">${fmtZAR(summary.totalInvoiced)}</div>
            </td>
            <td style="width:4px;"></td>
            <td style="background:${BRAND.outerBg}; border:1px solid ${BRAND.borderColor}; border-radius:6px; padding:12px; text-align:center; width:25%;">
              <div style="font-family:${BRAND.fontStack}; font-size:10px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Paid</div>
              <div style="font-family:${BRAND.fontStack}; font-size:16px; font-weight:bold; color:#16a34a; margin-top:4px;">${fmtZAR(summary.totalPaid)}</div>
            </td>
            <td style="width:4px;"></td>
            <td style="background:${BRAND.outerBg}; border:1px solid ${BRAND.borderColor}; border-radius:6px; padding:12px; text-align:center; width:25%;">
              <div style="font-family:${BRAND.fontStack}; font-size:10px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Credits</div>
              <div style="font-family:${BRAND.fontStack}; font-size:16px; font-weight:bold; color:#0891b2; margin-top:4px;">${fmtZAR(summary.totalCredits)}</div>
            </td>
            <td style="width:4px;"></td>
            <td style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:12px; text-align:center; width:25%;">
              <div style="font-family:${BRAND.fontStack}; font-size:10px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Balance Due</div>
              <div style="font-family:${BRAND.fontStack}; font-size:16px; font-weight:bold; color:${balanceColor}; margin-top:4px;">${fmtZAR(summary.balance)}</div>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border:1px solid ${BRAND.borderColor}; border-radius:6px; overflow:hidden; border-collapse:collapse;">
          <thead>
            <tr style="background:${BRAND.darkBg};">
              <th style="padding:8px; text-align:left; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.white}; font-weight:600;">Date</th>
              <th style="padding:8px; text-align:left; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.white}; font-weight:600;">Type</th>
              <th style="padding:8px; text-align:left; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.white}; font-weight:600;">Reference</th>
              <th style="padding:8px; text-align:right; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.white}; font-weight:600;">Debit</th>
              <th style="padding:8px; text-align:right; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.white}; font-weight:600;">Credit</th>
              <th style="padding:8px; text-align:right; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.white}; font-weight:600;">Balance</th>
            </tr>
          </thead>
          <tbody>${txnRows}</tbody>
        </table>
      </td>
    </tr>`;

  return emailLayout(content);
}
