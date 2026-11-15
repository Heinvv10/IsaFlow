/**
 * getComplianceCalendarWithDB must build the VAT201 calendar from the
 * company's own VAT settings (vat_period, vat_period_alignment,
 * vat_system_type), read with company_id. Dropping that read must go red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { getComplianceCalendarWithDB } from '@/modules/accounting/services/reports/sarsComplianceService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-0000000000c1';

function serveCompany(row: Record<string, string | null>): void {
  vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    return Promise.resolve(/FROM\s+companies\b/i.test(text) ? [row] : []);
  }) as never);
}

async function vat201Dues(): Promise<string[]> {
  const events = await getComplianceCalendarWithDB(COMPANY_ID, 2026);
  return events.filter((e) => e.eventType === 'VAT201_DUE').map((e) => e.dueDate);
}

describe('getComplianceCalendarWithDB reads the company VAT cycle', () => {
  beforeEach(() => { vi.mocked(sql).mockReset(); });

  it('a Category A company row yields Category A due dates', async () => {
    serveCompany({ vat_period: 'bi-monthly', vat_period_alignment: 'odd', vat_system_type: 'invoice' });
    expect(await vat201Dues()).toEqual(['2026-02-25', '2026-04-25', '2026-06-25', '2026-08-25', '2026-10-25', '2026-12-25']);
  });

  it('a Category B company row yields Category B due dates', async () => {
    serveCompany({ vat_period: 'Bi-Monthly', vat_period_alignment: 'even', vat_system_type: 'invoice' });
    expect(await vat201Dues()).toEqual(['2026-03-25', '2026-05-25', '2026-07-25', '2026-09-25', '2026-11-25', '2027-01-25']);
  });

  it('a monthly vendor gets twelve VAT201 events', async () => {
    serveCompany({ vat_period: 'monthly', vat_period_alignment: 'even', vat_system_type: 'invoice' });
    expect(await vat201Dues()).toHaveLength(12);
  });

  it('a non-vendor gets no VAT201 events', async () => {
    serveCompany({ vat_period: 'bi-monthly', vat_period_alignment: 'odd', vat_system_type: 'none' });
    expect(await vat201Dues()).toEqual([]);
  });

  it('reads the companies row by the caller company id', async () => {
    serveCompany({ vat_period: 'bi-monthly', vat_period_alignment: 'even', vat_system_type: 'invoice' });
    await vat201Dues();
    const companyCall = vi.mocked(sql).mock.calls.find((c) => /FROM\s+companies\b/i.test((c[0] as TemplateStringsArray).join('?')));
    expect(companyCall).toBeDefined();
    expect(companyCall!.slice(1)).toContain(COMPANY_ID);
  });
});
