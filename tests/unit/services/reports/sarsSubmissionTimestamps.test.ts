/**
 * A sars_submissions row's submitted_at arrives from pg as a Date: the API sends it as ISO 8601,
 * never Date.toString() (which the Filings page printed raw: "... GMT+0200 (South Africa Standard Time)").
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { getSubmission, listSubmissions } from '@/modules/accounting/services/reports/sarsComplianceService';

const row = {
  id: 's1', form_type: 'EMP201', period_start: '2026-10-01', period_end: '2026-10-31', status: 'submitted', form_data: {},
  submission_reference: 'R', submitted_at: new Date('2026-11-16T14:05:08.000Z'), submitted_by: null, efiling_channel: null,
  notes: null, created_at: new Date('2026-11-16T10:00:00.000Z'), updated_at: new Date('2026-11-16T14:05:08.000Z'),
};

describe('submittedAt', () => {
  it('a Date submitted_at is sent as ISO 8601, never with "GMT"', async () => {
    vi.mocked(sql).mockResolvedValue([row] as never);
    const [s] = await listSubmissions('c1');
    expect(s!.submittedAt).toBe('2026-11-16T14:05:08.000Z');
    expect((await getSubmission('c1', 's1'))!.submittedAt).not.toMatch(/GMT/);
  });
  it('no submitted_at is null', async () => {
    vi.mocked(sql).mockResolvedValue([{ ...row, submitted_at: null }] as never);
    expect((await listSubmissions('c1'))[0]!.submittedAt).toBeNull();
  });
});
