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

type Row = Record<string, unknown>;

/** Serves the companies row (none when `row` is null) and the given sars_compliance_events rows. */
function serveCompany(row: Row | null, events: Row[] = []): void {
  vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/FROM\s+companies\b/i.test(text)) return Promise.resolve(row ? [row] : []);
    return Promise.resolve(/sars_compliance_events/.test(text) ? events : []);
  }) as never);
}

async function vat201Dues(year = 2026): Promise<string[]> {
  const events = await getComplianceCalendarWithDB(COMPANY_ID, year);
  return events.filter((e) => e.eventType === 'VAT201_DUE').map((e) => e.dueDate);
}

const CAT_A = { vat_period: 'bi-monthly', vat_period_alignment: 'odd', vat_system_type: 'invoice' };
const CAT_B = { vat_period: 'bi-monthly', vat_period_alignment: 'even', vat_system_type: 'invoice' };
const CAT_C = { vat_period: 'monthly', vat_period_alignment: 'odd', vat_system_type: 'invoice' };

describe('getComplianceCalendarWithDB reads the company VAT cycle', () => {
  beforeEach(() => { vi.mocked(sql).mockReset(); });

  it('a Category A company row yields Category A due dates', async () => {
    serveCompany(CAT_A);
    expect(await vat201Dues()).toEqual(['2026-02-25', '2026-04-25', '2026-06-25', '2026-08-25', '2026-10-25', '2026-12-25', '2027-02-25']);
  });

  it('a Category B company row yields Category B due dates', async () => {
    serveCompany({ vat_period: 'Bi-Monthly', vat_period_alignment: 'even', vat_system_type: 'invoice' });
    expect(await vat201Dues()).toEqual(['2026-01-25', '2026-03-25', '2026-05-25', '2026-07-25', '2026-09-25', '2026-11-25', '2027-01-25', '2027-03-25']);
  });

  it('a monthly vendor gets one VAT201 event per month in the window', async () => {
    serveCompany({ ...CAT_C, vat_period_alignment: 'even' });
    const dues = await vat201Dues();
    expect(dues).toHaveLength(15);
    expect(dues[0]).toBe('2026-01-25');
    expect(dues.at(-1)).toBe('2027-03-25');
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

describe('getComplianceCalendarWithDB covers the year boundary (page shows overdue + next 90 days)', () => {
  beforeEach(() => { vi.mocked(sql).mockReset(); });

  it('Cat A on 28 Dec 2026 sees the Dec–Jan return due 2027-02-25', async () => {
    serveCompany(CAT_A);
    expect(await vat201Dues(2026)).toContain('2027-02-25');
  });

  it('Cat B on 10 Jan 2027 sees the Nov–Dec 2026 return due 2027-01-25', async () => {
    serveCompany(CAT_B);
    expect(await vat201Dues(2027)).toContain('2027-01-25');
  });

  it('a monthly vendor on 10 Jan 2027 sees the Dec 2026 return due 2027-01-25', async () => {
    serveCompany(CAT_C);
    expect(await vat201Dues(2027)).toContain('2027-01-25');
  });

  it('pulls in no event due before the year (no stale overdue items) and no duplicates', async () => {
    serveCompany(CAT_C);
    const events = await getComplianceCalendarWithDB(COMPANY_ID, 2027);
    expect(events.every((e) => e.dueDate >= '2027-01-01' && e.dueDate <= '2028-03-31')).toBe(true);
    const keys = events.map((e) => `${e.eventType}_${e.dueDate}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(events.map((e) => e.dueDate)).toEqual([...events.map((e) => e.dueDate)].sort());
  });
});

describe('getComplianceCalendarWithDB failure and DB-row shapes', () => {
  beforeEach(() => { vi.mocked(sql).mockReset(); });

  it('throws when the company row is missing instead of assuming Category A', async () => {
    serveCompany(null);
    await expect(getComplianceCalendarWithDB(COMPANY_ID, 2026)).rejects.toThrow(/company/i);
  });

  it('overlays a stored event whose due_date arrives as a local-midnight Date', async () => {
    serveCompany(CAT_A, [{ id: 'e1', event_type: 'VAT201_DUE', due_date: new Date(2026, 1, 25), status: 'completed', submission_id: null }]);
    const events = await getComplianceCalendarWithDB(COMPANY_ID, 2026);
    const feb = events.find((e) => e.eventType === 'VAT201_DUE' && e.dueDate === '2026-02-25');
    expect(feb?.status).toBe('completed');
  });

  it('overlays a stored event whose due_date arrives as a YYYY-MM-DD string', async () => {
    serveCompany(CAT_A, [{ id: 'e2', event_type: 'VAT201_DUE', due_date: '2026-04-25', status: 'completed', submission_id: null }]);
    const events = await getComplianceCalendarWithDB(COMPANY_ID, 2026);
    expect(events.find((e) => e.dueDate === '2026-04-25' && e.eventType === 'VAT201_DUE')?.status).toBe('completed');
  });
});
