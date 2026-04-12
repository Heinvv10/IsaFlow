/**
 * Customer Statement HTML Generator
 * Extracted from pages/api/accounting/customer-statement.ts to keep that file ≤300 lines.
 */

interface StatementTransaction {
  id: string;
  date: string;
  type: 'invoice' | 'payment' | 'credit_note';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

interface ClientData {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

interface StatementSummary {
  totalInvoiced: number;
  totalPaid: number;
  totalCredits: number;
  balance: number;
}

const fmtZAR = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtDate = (d: string) => {
  const parts = d.split('T')[0]?.split('-') ?? [];
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
};

const typeLabels: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit Note',
};

export function buildStatementHtml(
  clientData: ClientData,
  transactions: StatementTransaction[],
  summary: StatementSummary,
  from: string,
  to: string,
  companyName: string,
  companyVatNumber: string,
): string {
  const rows = transactions.map(t => `
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td>${typeLabels[t.type] || t.type}</td>
      <td>${t.reference}</td>
      <td>${(t.description || '').substring(0, 40)}</td>
      <td class="num">${t.debit > 0 ? fmtZAR(t.debit) : ''}</td>
      <td class="num">${t.credit > 0 ? fmtZAR(t.credit) : ''}</td>
      <td class="num bal">${fmtZAR(t.balance)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Statement — ${clientData.name}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 10px; color: #222; padding: 20mm; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .header { display: flex; justify-content: space-between; margin-bottom: 8mm; }
  .header-left .company { font-size: 12px; font-weight:bold; }
  .header-right { text-align: right; }
  .header-right .client-name { font-size: 14px; font-weight:bold; }
  .divider { border-top: 1px solid #ccc; margin: 4mm 0; }
  .summary { display: flex; gap: 8mm; margin-bottom: 6mm; padding: 4mm; background:#f5f7fa; border-radius:4px; }
  .summary-box { flex: 1; text-align: center; }
  .summary-box .label { font-size: 8px; color:#666; text-transform: uppercase; }
  .summary-box .value { font-size: 13px; font-weight:bold; }
  table { width:100%; border-collapse: collapse; margin-top: 4mm; }
  th { background:#1a3a6b; color:#fff; padding: 4px 6px; text-align:left; font-size:9px; }
  td { padding: 3px 6px; border-bottom: 1px solid #eee; font-size: 9px; }
  tr:nth-child(even) td { background: #f8fafc; }
  .num { text-align:right; font-family: monospace; }
  .bal { font-weight:bold; }
  .footer { margin-top: 8mm; font-size: 8px; color: #999; border-top: 1px solid #eee; padding-top: 3mm; }
  @media print { @page { size: A4 portrait; margin: 15mm; } body { padding:0; } }
</style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <h1>STATEMENT</h1>
    ${companyName ? `<div class="company">${companyName}</div>` : ''}
    ${companyVatNumber ? `<div>VAT No: ${companyVatNumber}</div>` : ''}
  </div>
  <div class="header-right">
    <div class="client-name">${clientData.name}</div>
    ${clientData.email ? `<div>${clientData.email}</div>` : ''}
    ${clientData.phone ? `<div>${clientData.phone}</div>` : ''}
    <div style="margin-top:4px">Period: ${from} to ${to}</div>
    <div>Generated: ${new Date().toLocaleDateString('en-ZA')}</div>
  </div>
</div>
<div class="divider"></div>
<div class="summary">
  <div class="summary-box"><div class="label">Total Invoiced</div><div class="value">${fmtZAR(summary.totalInvoiced)}</div></div>
  <div class="summary-box"><div class="label">Total Paid</div><div class="value">${fmtZAR(summary.totalPaid)}</div></div>
  <div class="summary-box"><div class="label">Credits Applied</div><div class="value">${fmtZAR(summary.totalCredits)}</div></div>
  <div class="summary-box"><div class="label">Balance Due</div><div class="value" style="color:${summary.balance > 0 ? '#b43232' : '#16a34a'}">${fmtZAR(summary.balance)}</div></div>
</div>
<table>
  <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:8px">No transactions in this period</td></tr>'}</tbody>
</table>
<div class="footer">ISAFlow Customer Statement — Confidential &nbsp;|&nbsp; ${clientData.name} &nbsp;|&nbsp; ${from} – ${to}</div>
<script>window.onload = function() { window.print(); }</script>
</body>
</html>`;
}
