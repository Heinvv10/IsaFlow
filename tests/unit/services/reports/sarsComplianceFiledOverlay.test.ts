/**
 * The SARS calendar's "marked filed" overlay: every item carries the period it covers, a mark
 * matches on (event type, period end) so it survives a due-date rule change, a pre-999c row (no
 * period_end) still matches on (event type, due date), and the marks are read in their own
 * savepoint so a failed read leaves the request transaction usable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }),
  withSavepoint: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql, withSavepoint } from '@/lib/neon';
import { getComplianceCalendarWithDB } from '@/modules/accounting/services/reports/sarsComplianceService';
import { getComplianceCalendarWithMarks } from '@/modules/accounting/services/reports/sarsComplianceCalendarDb';
import { getComplianceCalendar } from '@/modules/accounting/services/reports/sarsTaxPeriodsService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-0000000000c1';
const CAT_A = { vat_period: 'bi-monthly', vat_period_alignment: 'odd', vat_system_type: 'invoice' };
type Row = Record<string, unknown>;

/** Serves the companies row and the marks; `marks` may be an Error to fail the marks read. */
function serve(marks: Row[] | Error): void {
  vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/FROM\s+companies\b/i.test(text)) return Promise.resolve([CAT_A]);
    if (/sars_compliance_events/.test(text)) return marks instanceof Error ? Promise.reject(marks) : Promise.resolve(marks);
    return Promise.resolve([]);
  }) as never);
}

const find = (events: Awaited<ReturnType<typeof getComplianceCalendarWithDB>>, type: string, periodEnd: string) =>
  events.find((e) => e.eventType === type && e.periodEnd === periodEnd);

describe('every calendar item carries the period it covers', () => {
  const by = (type: string) => getComplianceCalendar(2026, 'odd', 'bi-monthly').filter((e) => e.eventType === type);

  it('VAT201: the VAT period end (Cat A Feb–Mar ends 31 Mar, due 24 Apr)', () => {
    expect(by('VAT201_DUE').find((e) => e.dueDate === '2026-04-24')?.periodEnd).toBe('2026-03-31');
  });
  it('EMP201: the month end (Feb 2026 ends 28 Feb, due 6 Mar)', () => {
    expect(by('EMP201_DUE').map((e) => e.periodEnd).slice(0, 3)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
  it('EMP501: annual = end Feb of the year, interim = 31 Aug', () => {
    expect(by('EMP501_DUE').map((e) => e.periodEnd)).toEqual(['2026-02-28', '2026-08-31']);
  });
  it('IRP6: first = 31 Aug, second = end Feb of the next year (leap aware)', () => {
    expect(by('PROVISIONAL_TAX').map((e) => e.periodEnd)).toEqual(['2026-08-31', '2027-02-28']);
    expect(getComplianceCalendar(2027, 'odd', 'none').filter((e) => e.eventType === 'PROVISIONAL_TAX').map((e) => e.periodEnd))
      .toEqual(['2027-08-31', '2028-02-29']);
  });
  it('period starts: VAT the VAT period start, EMP201 the 1st, EMP501 and IRP6 the tax year (from 1 Mar)', () => {
    expect(by('VAT201_DUE').find((e) => e.dueDate === '2026-04-24')?.periodStart).toBe('2026-02-01');
    expect(by('EMP201_DUE')[1]?.periodStart).toBe('2026-02-01');
    expect(by('EMP501_DUE').map((e) => e.periodStart)).toEqual(['2025-03-01', '2026-03-01']);
    expect(by('PROVISIONAL_TAX').map((e) => e.periodStart)).toEqual(['2026-03-01', '2026-03-01']);
  });
  it('no two items of one type share a period end', () => {
    const keys = getComplianceCalendar(2026, 'odd', 'monthly').map((e) => `${e.eventType}_${e.periodEnd}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('getComplianceCalendarWithDB lays marks over the calendar', () => {
  beforeEach(() => { vi.mocked(sql).mockReset(); vi.mocked(withSavepoint).mockClear(); });

  it('a mark matches on (type, period end) even when its stored due date differs (rule changed since)', async () => {
    serve([{ id: 'm1', event_type: 'EMP201_DUE', due_date: '2026-03-09', period_start: '2026-02-01', period_end: '2026-02-28', status: 'completed',
      sars_reference: 'REF-9', filed_at: new Date('2026-03-05T08:00:00Z'), filed_by_name: 'Willie' }]);
    const e = find(await getComplianceCalendarWithDB(COMPANY_ID, 2026), 'EMP201_DUE', '2026-02-28');
    expect(e).toMatchObject({ id: 'm1', status: 'completed', sarsReference: 'REF-9', filedBy: 'Willie', filedAt: '2026-03-05T08:00:00.000Z' });
  });

  it('a mark made before a holiday shift still matches: EMP201 Mar 2023 now due Thu 6 Apr, stored due date Fri 7 Apr (Good Friday)', async () => {
    serve([{ id: 'm3', event_type: 'EMP201_DUE', due_date: '2023-04-07', period_start: '2023-03-01', period_end: '2023-03-31', status: 'completed' }]);
    const e = find(await getComplianceCalendarWithDB(COMPANY_ID, 2023), 'EMP201_DUE', '2023-03-31');
    expect(e).toMatchObject({ id: 'm3', status: 'completed', dueDate: '2023-04-06' });
  });

  it('a mark does not match another period of the same type that shares its stored due date', async () => {
    // Stored due date is January's (6 Feb), but the mark is February's period.
    serve([{ id: 'm2', event_type: 'EMP201_DUE', due_date: '2026-02-06', period_start: '2026-02-01', period_end: '2026-02-28', status: 'completed' }]);
    const events = await getComplianceCalendarWithDB(COMPANY_ID, 2026);
    expect(find(events, 'EMP201_DUE', '2026-01-31')?.id).toBeUndefined();
    expect(find(events, 'EMP201_DUE', '2026-02-28')?.id).toBe('m2');
  });

  it('a pre-999c row (no period_end) still matches on (type, due date)', async () => {
    serve([{ id: 'legacy', event_type: 'EMP201_DUE', due_date: '2026-03-06', period_end: null, status: 'completed' }]);
    const e = find(await getComplianceCalendarWithDB(COMPANY_ID, 2026), 'EMP201_DUE', '2026-02-28');
    expect(e).toMatchObject({ id: 'legacy', status: 'completed' });
  });

  it('a mark of one type never marks another type with the same period end', async () => {
    serve([{ id: 'm3', event_type: 'EMP501_DUE', due_date: '2026-10-30', period_start: '2026-03-01', period_end: '2026-08-31', status: 'completed' }]);
    const events = await getComplianceCalendarWithDB(COMPANY_ID, 2026);
    expect(find(events, 'PROVISIONAL_TAX', '2026-08-31')?.status).not.toBe('completed');
    expect(find(events, 'EMP501_DUE', '2026-08-31')?.status).toBe('completed');
  });

  it('the marks read runs in its own savepoint, scoped by company_id', async () => {
    serve([]);
    await getComplianceCalendarWithDB(COMPANY_ID, 2026);
    expect(vi.mocked(withSavepoint).mock.calls.map((c) => c[0])).toContain('sars_calendar_marks');
    const call = vi.mocked(sql).mock.calls.find((c) => /sars_compliance_events/.test((c[0] as TemplateStringsArray).join('?')));
    expect(call!.slice(1)).toContain(COMPANY_ID);
  });

  it('a mark made under another cadence (same end, other start) does not mark the item', async () => {
    // Bi-monthly Jan–Feb VAT mark; the company is Cat A, whose Feb–Mar period ends 31 Mar: craft a
    // mark ending 31 Mar but starting 1 Mar (a monthly period).
    serve([{ id: 'm4', event_type: 'VAT201_DUE', due_date: '2026-04-24', period_start: '2026-03-01', period_end: '2026-03-31', status: 'completed' }]);
    const e = find(await getComplianceCalendarWithDB(COMPANY_ID, 2026), 'VAT201_DUE', '2026-03-31');
    expect(e?.periodStart).toBe('2026-02-01');
    expect(e?.id).toBeUndefined();
  });

  it('marksUnavailable is false when the marks were read', async () => {
    serve([]);
    expect((await getComplianceCalendarWithMarks(COMPANY_ID, 2026)).marksUnavailable).toBe(false);
  });

  it('a failed marks read returns the bare calendar with marksUnavailable', async () => {
    serve(Object.assign(new Error('permission denied for table sars_compliance_events'), { code: '42501' }));
    const out = await getComplianceCalendarWithMarks(COMPANY_ID, 2026);
    expect(out.marksUnavailable).toBe(true);
    expect(out.events.length).toBeGreaterThan(10);
  });

  it('a failed marks read falls back to the static calendar', async () => {
    serve(Object.assign(new Error('permission denied for table sars_compliance_events'), { code: '42501' }));
    const events = await getComplianceCalendarWithDB(COMPANY_ID, 2026);
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((e) => e.id === undefined)).toBe(true);
  });
});

describe('a pre-999c mark made under the old weekend-only due date', () => {
  beforeEach(() => { vi.mocked(sql).mockReset(); });

  it('Cat A Oct–Nov 2026 VAT201: a legacy row dated Fri 25 Dec (old) matches the item now due Thu 24 Dec', async () => {
    serve([{ id: 'old-xmas', event_type: 'VAT201_DUE', due_date: '2026-12-25', period_end: null, status: 'completed' }]);
    const e = find(await getComplianceCalendarWithDB(COMPANY_ID, 2026), 'VAT201_DUE', '2026-11-30');
    expect(e).toMatchObject({ id: 'old-xmas', status: 'completed', dueDate: '2026-12-24' });
  });

  it('a legacy row on an unrelated date does not match', async () => {
    serve([{ id: 'stray', event_type: 'VAT201_DUE', due_date: '2026-12-18', period_end: null, status: 'completed' }]);
    const e = find(await getComplianceCalendarWithDB(COMPANY_ID, 2026), 'VAT201_DUE', '2026-11-30');
    expect(e?.id).toBeUndefined();
  });

  it('a legacy row of another type on 25 Dec does not match the VAT item', async () => {
    serve([{ id: 'other', event_type: 'EMP201_DUE', due_date: '2026-12-25', period_end: null, status: 'completed' }]);
    const e = find(await getComplianceCalendarWithDB(COMPANY_ID, 2026), 'VAT201_DUE', '2026-11-30');
    expect(e?.id).toBeUndefined();
  });
});
