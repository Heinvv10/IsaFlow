/**
 * Weekend rule for the bureau compliance engine (TAA s244): a statutory due
 * date on a Saturday or Sunday moves BACK to the Friday, for every deadline
 * type, matching the SARS page's calendar (sarsTaxPeriodsService). Public
 * holidays are not shifted (no holiday calendar). CIPC is not a SARS
 * deadline; it gets the same shift for safety.
 */
import { describe, it, expect } from 'vitest';
import { upcomingObligations, type EngineConfig } from '@/modules/bureau/services/complianceCalendarEngine';
import { getComplianceCalendar } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';

const NONE: EngineConfig = {
  vat: { enabled: false, period: 'bi-monthly', alignment: 'odd' },
  emp201Enabled: false,
  emp501Enabled: false,
  provisionalTax: { enabled: false, yearEndMonth: 2 },
  cipc: { enabled: false, anniversaryMonth: null },
};
const cfg = (o: Partial<EngineConfig>): EngineConfig => ({ ...NONE, ...o });
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const dues = (items: ReturnType<typeof upcomingObligations>, kind: string) =>
  items.filter((i) => i.kind === kind).map((i) => i.dueDate);

describe('bureau engine — weekend due dates move back to Friday', () => {
  it('VAT: Saturday 25 Jul 2026 → Friday 24 Jul (Cat B May–Jun)', () => {
    const items = upcomingObligations(cfg({ vat: { enabled: true, period: 'bi-monthly', alignment: 'even' } }), utc(2026, 6, 11));
    expect(dues(items, 'vat')).toEqual(['2026-07-24']);
  });

  it('VAT: Sunday 25 Oct 2026 → Friday 23 Oct (Cat A Aug–Sep)', () => {
    const items = upcomingObligations(cfg({ vat: { enabled: true, period: 'bi-monthly', alignment: 'odd' } }), utc(2026, 9, 1));
    expect(dues(items, 'vat')).toEqual(['2026-10-23']);
  });

  it('EMP501 annual: Sunday 31 May 2026 → Friday 29 May', () => {
    expect(dues(upcomingObligations(cfg({ emp501Enabled: true }), utc(2026, 3, 20)), 'emp501')).toEqual(['2026-05-29']);
  });

  it('EMP501 interim: Saturday 31 Oct 2026 → Friday 30 Oct', () => {
    expect(dues(upcomingObligations(cfg({ emp501Enabled: true }), utc(2026, 9, 15)), 'emp501')).toEqual(['2026-10-30']);
  });

  it('IRP6 2nd payment: Sunday 28 Feb 2027 → Friday 26 Feb', () => {
    const items = upcomingObligations(cfg({ provisionalTax: { enabled: true, yearEndMonth: 2 } }), utc(2026, 12, 15));
    expect(dues(items, 'provisional_tax')).toEqual(['2027-02-26']);
  });

  it('IRP6 1st payment: Sunday 31 Aug 2025 → Friday 29 Aug', () => {
    const items = upcomingObligations(cfg({ provisionalTax: { enabled: true, yearEndMonth: 2 } }), utc(2025, 6, 11));
    expect(dues(items, 'provisional_tax')).toEqual(['2025-08-29']);
  });

  it('CIPC: Saturday 31 Oct 2026 → Friday 30 Oct (same shift, for safety)', () => {
    const items = upcomingObligations(cfg({ cipc: { enabled: true, anniversaryMonth: 10 } }), utc(2026, 9, 15));
    expect(dues(items, 'cipc_annual_return')).toEqual(['2026-10-30']);
  });
});

describe('bureau engine agrees with the SARS page calendar', () => {
  it('Cat A bi-monthly, Feb year-end: same VAT201, EMP201, EMP501 and IRP6 dates in 2026', () => {
    const engine = upcomingObligations(
      cfg({
        vat: { enabled: true, period: 'bi-monthly', alignment: 'odd' },
        emp201Enabled: true,
        emp501Enabled: true,
        provisionalTax: { enabled: true, yearEndMonth: 2 },
      }),
      utc(2025, 12, 31), 400, 0,
    );
    const sars = [...getComplianceCalendar(2025, 'odd'), ...getComplianceCalendar(2026, 'odd')];
    const in2026 = (d: string) => d.startsWith('2026-');
    const pairs: Array<[string, string]> = [
      ['vat', 'VAT201_DUE'], ['emp201', 'EMP201_DUE'], ['emp501', 'EMP501_DUE'], ['provisional_tax', 'PROVISIONAL_TAX'],
    ];
    for (const [kind, type] of pairs) {
      const e = dues(engine, kind).filter(in2026).sort();
      const s = sars.filter((x) => x.eventType === type).map((x) => x.dueDate).filter(in2026).sort();
      expect(e.length, kind).toBeGreaterThan(0);
      expect(e, kind).toEqual(s);
    }
  });
});
