/**
 * M17 (mobile audit): the statement page declares a viewport, scrolls its table inside a named region,
 * and keeps the A4 print rules; the phone styles live in a screen-only media query.
 */
import { describe, expect, it } from 'vitest';
import { buildStatementHtml } from '@/modules/accounting/utils/customerStatementHtml';

const html = buildStatementHtml(
  { id: 'c1', name: 'Acme', email: null, phone: null, address: null },
  [{ id: 't1', date: '2026-10-01', type: 'invoice', reference: 'INV1', description: 'x', debit: 100, credit: 0, balance: 100 }],
  { openingBalance: 0, totalInvoiced: 100, totalPaid: 0, totalCredits: 0, balance: 100 },
  '2026-10-01', '2026-10-31', 'Co', '',
);

describe('buildStatementHtml on phones', () => {
  it('has a viewport meta tag', () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });
  it('wraps the table in a labelled, focusable scroll region', () => {
    expect(html).toMatch(/<div class="table-scroll" role="region" aria-label="Statement transactions" tabindex="0">\s*<table>/);
    expect(html).toMatch(/<\/table>\s*<\/div>/);
  });
  it('phone sizes are screen-only and the A4 print rules are intact', () => {
    expect(html).toContain('@media screen and (max-width: 700px)');
    expect(html).toContain('@media print { @page { size: A4 portrait; margin: 15mm; } body { padding:0; } }');
    const phone = html.slice(html.indexOf('@media screen'), html.indexOf('@media print'));
    expect(phone).toContain('font-size: 13px');
  });
});
