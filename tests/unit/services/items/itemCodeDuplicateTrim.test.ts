/**
 * checkCodeDuplicate compares against the stored code trimmed, so a legacy row saved
 * as 'FIB-0001 ' (before PUT trimmed) still blocks a second item taking 'FIB-0001'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    calls.push(strings.join('?'));
    return [];
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { checkCodeDuplicate } from '@/modules/accounting/services/items/itemService';

describe('checkCodeDuplicate', () => {
  beforeEach(() => { calls.length = 0; });

  it('matches the stored code trimmed, with and without an excluded id', async () => {
    await checkCodeDuplicate('c1', 'FIB-0001');
    await checkCodeDuplicate('c1', 'FIB-0001', 'id-1');
    expect(calls).toHaveLength(2);
    for (const q of calls) {
      expect(q).toMatch(/company_id = \?/);
      expect(q).toMatch(/btrim\(code\) = \?/);
    }
  });
});
