/**
 * The SARS calendar completes an item from the company's own filed sars_submissions (read scoped by
 * company_id, in its own savepoint), and says how it was filed: `efiled` (sent through IsaFlow's ISV
 * channel and accepted by SARS), `processing` (sent through ISV, SARS not final yet) or `recorded`
 * (a user recorded the filing in IsaFlow: no channel). Every covering filing is listed (deduplicated,
 * in period order). A manual mark on the same item stays exposed, so it can still be undone. Only a
 * database error (a SQLSTATE code) makes a read "unavailable"; any other error propagates.
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

function serve(subs: Row[] | Error, marks: Row[] | Error = []): void {
  vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/FROM\s+companies\b/i.test(text)) return Promise.resolve([CAT_B]);
    if (/FROM\s+sars_submissions/.test(text)) return subs instanceof Error ? Promise.reject(subs) : Promise.resolve(subs);
    if (/sars_compliance_events/.test(text)) return marks instanceof Error ? Promise.reject(marks) : Promise.resolve(marks);
    return Promise.resolve([]);
  }) as never);
}
const subRow = (form_type: string, period_start: string, period_end: string, extra: Row = {}): Row =>
  ({ form_type, period_start, period_end, submission_reference: null, submitted_at: null, status: 'submitted',
     efiling_channel: null, submitted_by_name: null, ...extra });
const mark = (extra: Row = {}): Row => ({ id: 'm1', event_type: 'EMP201_DUE', due_date: '2026-03-06', period_start: '2026-02-01',
  period_end: '2026-02-28', status: 'completed', sars_reference: 'MANUAL', filed_at: '2026-03-01T00:00:00Z', filed_by_name: 'Willie', ...extra });
const pgError = (code: string) => Object.assign(new Error('db said no'), { code });
const get = async () => getComplianceCalendarWithMarks(CO, 2026);
const item = (events: Awaited<ReturnType<typeof get>>['events'], type: string, periodEnd: string) =>
  events.find((e) => e.eventType === type && e.periodEnd === periodEnd);

beforeEach(() => { vi.mocked(sql).mockReset(); vi.mocked(withSavepoint).mockClear(); });

describe('how an item was filed', () => {
  it('ISV + accepted: efiled, with the reference and time', async () => {
    serve([subRow('EMP201', '2025-12-01', '2025-12-31', { efiling_channel: 'isv', status: 'accepted',
      submission_reference: 'SARS-9', submitted_at: new Date('2026-01-05T10:00:00Z') })]);
    expect(item((await get()).events, 'EMP201_DUE', '2025-12-31')).toMatchObject({
      status: 'completed', efiling: { kind: 'efiled', filings: [{ reference: 'SARS-9', submittedAt: '2026-01-05T10:00:00.000Z' }] } });
  });

  it('ISV + submitted (SARS not final): processing', async () => {
    serve([subRow('EMP201', '2025-12-01', '2025-12-31', { efiling_channel: 'isv', status: 'submitted' })]);
    expect(item((await get()).events, 'EMP201_DUE', '2025-12-31')?.efiling?.kind).toBe('processing');
  });

  it('no channel (recorded by a user): recorded, with who', async () => {
    serve([subRow('EMP201', '2025-12-01', '2025-12-31', { submission_reference: 'U-1', submitted_by_name: 'Willie' })]);
    expect(item((await get()).events, 'EMP201_DUE', '2025-12-31')?.efiling).toMatchObject({
      kind: 'recorded', filings: [{ reference: 'U-1', by: 'Willie' }] });
  });

  it('a mix is described by its least certain filing', async () => {
    serve([subRow('VAT201', '2026-01-01', '2026-01-31', { efiling_channel: 'isv', status: 'accepted' }),
      subRow('VAT201', '2026-02-01', '2026-02-28', { efiling_channel: 'isv', status: 'submitted' })]);
    expect(item((await get()).events, 'VAT201_DUE', '2026-02-28')?.efiling?.kind).toBe('processing');
    serve([subRow('VAT201', '2026-01-01', '2026-01-31', { efiling_channel: 'isv', status: 'accepted' }),
      subRow('VAT201', '2026-02-01', '2026-02-28')]);
    expect(item((await get()).events, 'VAT201_DUE', '2026-02-28')?.efiling?.kind).toBe('recorded');
  });
});

describe('several filings', () => {
  it('every filing is listed, in period order, identical rows once', async () => {
    serve([
      subRow('VAT201', '2026-02-01', '2026-02-28', { submission_reference: 'B' }),
      subRow('VAT201', '2026-01-01', '2026-01-31', { submission_reference: 'A' }),
      subRow('VAT201', '2026-01-01', '2026-01-31', { submission_reference: 'A' }),
    ]);
    const f = item((await get()).events, 'VAT201_DUE', '2026-02-28')?.efiling?.filings;
    expect(f?.map((x) => x.reference)).toEqual(['A', 'B']);
  });
});

describe('a filing and a manual mark on one item', () => {
  it('the filing is shown and the mark stays exposed (so it can be undone)', async () => {
    serve([subRow('EMP201', '2026-02-01', '2026-02-28', { submission_reference: 'S-1' })], [mark()]);
    const e = item((await get()).events, 'EMP201_DUE', '2026-02-28');
    expect(e).toMatchObject({ status: 'completed', efiling: { kind: 'recorded' }, id: 'm1', filedBy: 'Willie' });
  });

  it('a manual mark alone still shows as the mark', async () => {
    serve([], [mark({ id: 'm2' })]);
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

  it('a database error: submissionsUnavailable, the calendar and marks still served', async () => {
    serve(pgError('42501'), [mark({ id: 'm3' })]);
    const out = await get();
    expect(out.submissionsUnavailable).toBe(true);
    expect(out.marksUnavailable).toBe(false);
    expect(item(out.events, 'EMP201_DUE', '2026-02-28')?.id).toBe('m3');
  });

  it('a successful read: submissionsUnavailable false', async () => {
    serve([]);
    expect((await get()).submissionsUnavailable).toBe(false);
  });

  it('a code bug (no SQLSTATE) in the submissions read propagates', async () => {
    serve(new TypeError('x is not a function'));
    await expect(get()).rejects.toBeInstanceOf(TypeError);
  });

  it('a code bug in the marks read propagates too; a database error there is "unavailable"', async () => {
    serve([], new TypeError('boom'));
    await expect(get()).rejects.toBeInstanceOf(TypeError);
    serve([], pgError('57014'));
    expect((await get()).marksUnavailable).toBe(true);
  });
});
