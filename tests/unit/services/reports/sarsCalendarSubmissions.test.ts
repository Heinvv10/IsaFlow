/**
 * The SARS calendar shows an item IsaFlow filed as completed ("Filed on eFiling") from the company's
 * own sars_submissions: only filed statuses, scoped by company_id, read in its own savepoint. A
 * failed read sets submissionsUnavailable and keeps the calendar (and the marks). A submission is
 * shown over a manual mark on the same item, and the manual mark's undo fields are not exposed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }),
  withSavepoint: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql, withSavepoint } from '@/lib/neon';
import { getComplianceCalendarWithMarks } from '@/modules/accounting/services/reports/sarsComplianceCalendarDb';

const CO = 'aaaaaaaa-0000-0000-0000-0000000000c1';
const CAT_B = { vat_period: 'bi-monthly', vat_period_alignment: 'even', vat_system_type: 'invoice' };
type Row = Record<string, unknown>;

function serve(subs: Row[] | Error, marks: Row[] = []): void {
  vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/FROM\s+companies\b/i.test(text)) return Promise.resolve([CAT_B]);
    if (/FROM\s+sars_submissions/.test(text)) return subs instanceof Error ? Promise.reject(subs) : Promise.resolve(subs);
    if (/sars_compliance_events/.test(text)) return Promise.resolve(marks);
    return Promise.resolve([]);
  }) as never);
}
const subRow = (form_type: string, period_start: string, period_end: string, extra: Row = {}): Row =>
  ({ form_type, period_start, period_end, submission_reference: null, submitted_at: null, ...extra });
const get = async () => getComplianceCalendarWithMarks(CO, 2026);
const item = (events: Awaited<ReturnType<typeof get>>['events'], type: string, periodEnd: string) =>
  events.find((e) => e.eventType === type && e.periodEnd === periodEnd);

beforeEach(() => { vi.mocked(sql).mockReset(); vi.mocked(withSavepoint).mockClear(); });

describe('submissions complete calendar items', () => {
  it('an EMP201 for the month: completed, Filed on eFiling, with its reference and date', async () => {
    serve([subRow('EMP201', '2025-12-01', '2025-12-31', { submission_reference: 'SARS-9', submitted_at: new Date('2026-01-05T10:00:00Z') })]);
    const e = item((await get()).events, 'EMP201_DUE', '2025-12-31');
    expect(e).toMatchObject({ status: 'completed', efiling: { reference: 'SARS-9', submittedAt: '2026-01-05T10:00:00.000Z' } });
  });

  it('the latest covering submission supplies the reference', async () => {
    serve([
      subRow('EMP201', '2026-01-01', '2026-01-31', { submission_reference: 'OLD', submitted_at: '2026-02-01T00:00:00Z' }),
      subRow('EMP201', '2026-01-01', '2026-01-31', { submission_reference: 'NEW', submitted_at: '2026-02-03T00:00:00Z' }),
    ]);
    expect(item((await get()).events, 'EMP201_DUE', '2026-01-31')?.efiling?.reference).toBe('NEW');
  });

  it('a VAT201 covering one month of a bi-monthly period leaves it uncompleted', async () => {
    serve([subRow('VAT201', '2026-02-01', '2026-02-28')]);
    const e = item((await get()).events, 'VAT201_DUE', '2026-02-28');
    expect(e?.efiling).toBeUndefined();
    expect(e?.status).not.toBe('completed');
  });

  it('two monthly VAT201s complete the bi-monthly period', async () => {
    serve([subRow('VAT201', '2026-01-01', '2026-01-31'), subRow('VAT201', '2026-02-01', '2026-02-28')]);
    expect(item((await get()).events, 'VAT201_DUE', '2026-02-28')?.status).toBe('completed');
  });

  it('a submission is shown over a manual mark, and the mark is not exposed (no undo)', async () => {
    serve([subRow('EMP201', '2026-02-01', '2026-02-28', { submission_reference: 'S-1' })],
      [{ id: 'm1', event_type: 'EMP201_DUE', due_date: '2026-03-06', period_start: '2026-02-01', period_end: '2026-02-28',
        status: 'completed', sars_reference: 'MANUAL', filed_at: '2026-03-01T00:00:00Z', filed_by_name: 'Willie' }]);
    const e = item((await get()).events, 'EMP201_DUE', '2026-02-28');
    expect(e).toMatchObject({ status: 'completed', efiling: { reference: 'S-1' } });
    expect(e?.id).toBeUndefined();
    expect(e?.filedAt).toBeUndefined();
  });

  it('a manual mark alone still shows as the mark', async () => {
    serve([], [{ id: 'm2', event_type: 'EMP201_DUE', due_date: '2026-03-06', period_start: '2026-02-01', period_end: '2026-02-28',
      status: 'completed', filed_at: '2026-03-01T00:00:00Z', filed_by_name: 'Willie' }]);
    const e = item((await get()).events, 'EMP201_DUE', '2026-02-28');
    expect(e).toMatchObject({ id: 'm2', status: 'completed' });
    expect(e?.efiling).toBeUndefined();
  });
});

describe('the submissions read', () => {
  it('reads only filed statuses of VAT201/EMP201, scoped by company_id, in its own savepoint', async () => {
    serve([]);
    await get();
    const call = vi.mocked(sql).mock.calls.find((c) => /FROM\s+sars_submissions/.test((c[0] as TemplateStringsArray).join('?')));
    const text = (call![0] as TemplateStringsArray).join('?');
    expect(text).toMatch(/status IN \('submitted', 'accepted'\)/);
    expect(text).toMatch(/company_id = \?::UUID/);
    expect(call!.slice(1)).toContain(CO);
    expect(vi.mocked(withSavepoint).mock.calls.map((c) => c[0])).toContain('sars_calendar_submissions');
  });

  it('a failed read: submissionsUnavailable, the calendar and marks still served', async () => {
    serve(new Error('permission denied for table sars_submissions'),
      [{ id: 'm3', event_type: 'EMP201_DUE', due_date: '2026-03-06', period_start: '2026-02-01', period_end: '2026-02-28', status: 'completed' }]);
    const out = await get();
    expect(out.submissionsUnavailable).toBe(true);
    expect(out.marksUnavailable).toBe(false);
    expect(item(out.events, 'EMP201_DUE', '2026-02-28')?.id).toBe('m3');
  });

  it('a successful read: submissionsUnavailable false', async () => {
    serve([]);
    expect((await get()).submissionsUnavailable).toBe(false);
  });
});
