/** CSV of the SARS-numbered VAT201 — the field numbers, wording and amounts the server computed. */
import type { Vat201SarsField } from '@/modules/accounting/services/reports/vat201SarsFields';

function cell(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildVat201Csv(data: { periodStart: string; periodEnd: string; sarsFields: Vat201SarsField[] }): string {
  const rows = [
    ['Field', 'Description', 'Amount (ZAR)'],
    ...data.sarsFields.map((f) => [f.field, cell(f.label), f.amount === null ? '' : f.amount.toFixed(2)]),
    [],
    ['Period', `${data.periodStart} to ${data.periodEnd}`],
  ];
  return rows.map((r) => r.join(',')).join('\n');
}
