/**
 * A figure in a notice reads exactly like the table beside it. The notice
 * printed "R 2 700,00" — a no-break space and a decimal comma, from
 * `toLocaleString('en-ZA')` — under a table whose figures read "2 700.00".
 */
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/format/money';
import { buildDataQualityNotices } from '@/modules/accounting/services/reports/dataQualityNotices';

const unclassified = (amount: number) => ({ accounts: 3, amount, message: 'm' });

describe('the amount in a data-quality notice', () => {
  it('uses the app formatter: ASCII-space grouping and a decimal point', () => {
    const [notice] = buildDataQualityNotices({ unclassifiedAccounts: unclassified(2700) });
    expect(notice).toContain('carrying R 2 700.00 ');
    expect(notice).not.toContain(' ');
    expect(notice).not.toMatch(/\d,\d{2}\b/);
  });

  it('is the very string the screen\'s tables print for the same amount', () => {
    const amount = 114_177_043.06;
    const [notice] = buildDataQualityNotices({ unclassifiedAccounts: unclassified(amount) });
    expect(notice).toContain(formatMoney(amount, { cents: true, symbol: true }));
  });

  it('prints a per-type amount and the exposure ceilings the same way', () => {
    const notices = buildDataQualityNotices({
      unclassifiedAccounts: { accounts: 2, amount: 0, message: 'm', byType: [{ type: 'expense', accounts: 2, amount: 12345.5, defaultedTo: 'operating expenses' }] },
      costOfSalesExposureAtMost: 1000, otherIncomeExposureAtMost: 2500.25,
    });
    const text = notices.join(' ');
    expect(text).toContain('R 12 345.50');
    expect(text).toContain('R 1 000.00');
    expect(text).toContain('R 2 500.25');
    expect(text).not.toMatch(/\d,\d\d\b/);
  });

  it('says R 0.00 for a nil amount, never the table\'s dash', () => {
    const [notice] = buildDataQualityNotices({ unclassifiedAccounts: unclassified(0) });
    expect(notice).toContain('carrying R 0.00 ');
  });
});
