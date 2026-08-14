import { describe, it, expect } from 'vitest';
import { buildCsvRow } from '../../../pages/api/accounting/reports/customer-communication';

describe('customer-communication buildCsvRow', () => {
  it('quotes and escapes internal double-quotes', () => {
    const row = buildCsvRow(['Acme "Ltd"', 'a@b.com', 'Invoice', 'Hello, World', '2026-08-14', 'sent']);
    expect(row).toBe('"Acme ""Ltd""","a@b.com","Invoice","Hello, World","2026-08-14","sent"');
  });

  it('neutralizes a formula-injection prefix in customerName', () => {
    const row = buildCsvRow(['=1+1', 'a@b.com', 'Invoice', 'subject', '2026-08-14', 'sent']);
    expect(row.split(',')[0]).toBe('"\'=1+1"');
  });

  it('neutralizes a formula-injection prefix in subject', () => {
    const row = buildCsvRow(['Acme', 'a@b.com', 'Invoice', '=HYPERLINK("http://evil","x")', '2026-08-14', 'sent']);
    expect(row).toBe(
      '"Acme","a@b.com","Invoice","\'=HYPERLINK(""http://evil"",""x"")","2026-08-14","sent"',
    );
  });
});
