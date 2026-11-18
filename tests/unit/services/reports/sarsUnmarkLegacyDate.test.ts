/**
 * unmarkFiled removes a pre-999c mark (no period) stored under the OLD weekend-only due date as well as the
 * current one: the DELETE carries both dates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }),
  withSavepoint: vi.fn((_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn(async () => undefined) }));

import { sql } from '@/lib/neon';
import { unmarkFiled } from '@/modules/accounting/services/reports/sarsFiledMarks';

const CO = 'aaaaaaaa-0000-0000-0000-0000000000c1';
const CAT_A = { vat_period: 'bi-monthly', vat_period_alignment: 'odd', vat_system_type: 'invoice' };

function serve(deleted: Array<Record<string, unknown>>): { deletes: unknown[][] } {
  const deletes: unknown[][] = [];
  vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (/FROM\s+companies\b/i.test(text)) return Promise.resolve([CAT_A]);
    if (/DELETE FROM sars_compliance_events/.test(text)) { deletes.push(values); return Promise.resolve(deleted); }
    return Promise.resolve([]);
  }) as never);
  return { deletes };
}

describe('unmarkFiled: a legacy mark under the old due date', () => {
  beforeEach(() => { vi.mocked(sql).mockReset(); });

  it('the DELETE accepts both Thu 24 Dec (now) and Fri 25 Dec (old) for the Oct–Nov 2026 VAT201', async () => {
    const { deletes } = serve([{ id: 'x', description: 'VAT201', due_date: '2026-12-25', sars_reference: null }]);
    await unmarkFiled(CO, 'u1', { eventType: 'VAT201_DUE', periodEnd: '2026-11-30' });
    const dueDates = deletes[0]!.find((v) => Array.isArray(v)) as string[];
    expect(dueDates).toEqual(expect.arrayContaining(['2026-12-24', '2026-12-25']));
    expect(dueDates).not.toContain('2026-12-18');
  });
});
