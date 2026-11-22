/** #1656 round 8: the pay_run exclusion is IN the query (rows and count), bound from the caller's Payroll read, not applied to a fetched page. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ text: string; values: unknown[] }>);
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async (s: TemplateStringsArray, ...v: unknown[]) => { calls.push({ text: s.join('?'), values: v }); return [{ count: 0 }]; }) }));

import { getPendingCount, listRequests } from '@/modules/accounting/services/gl/approvalService';

const C = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { calls.length = 0; });

describe('pay_run requests in the pending count and the list', () => {
  it.each([[true], [false]])('includePayRun=%s is bound into the count and every list query, beside the pay_run predicate', async (inc) => {
    await getPendingCount(C, inc);
    await listRequests(C, undefined, inc);
    await listRequests(C, 'pending', inc);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.text).toMatch(/document_type <> 'pay_run'/);
      expect(c.values).toContain(inc);
    }
  });
});
