import { describe, it, expect } from 'vitest';
import { buildCsv, type CustomerRow } from '@/../pages/api/accounting/customers-bulk';

describe('customers-bulk CSV export — formula-injection safety', () => {
  it('neutralizes a leading formula character in a user-controlled name', () => {
    const rows: CustomerRow[] = [
      { name: '=HYPERLINK("http://evil","x")', email: '+1@e.co', phone: '-1', payment_terms: 30, credit_limit: 0, is_active: true },
    ];
    const csv = buildCsv(rows);
    const dataLine = csv.split('\n')[1]!;
    // Each dangerous field must be prefixed with a single quote by the shared escapeCsv helper.
    expect(dataLine).toContain("'=HYPERLINK");
    expect(dataLine).toContain("'+1@e.co");
    expect(dataLine).toContain("'-1");
    expect(dataLine).not.toMatch(/(^|,)=HYPERLINK/);
  });
});
