import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { guardedSource, isDatabaseError } from '@/modules/accounting/services/cashForecast13/guardedSource';
import type { ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';

describe('cash13 guardedSource', () => {
  it('a database error (SQLSTATE) becomes a source_unavailable warning and null', async () => {
    const warnings: ForecastWarning[] = [];
    const out = await guardedSource('sp', 'loans', warnings, () => Promise.reject(Object.assign(new Error('boom'), { code: '42P01' })));
    expect(out).toBeNull();
    expect(warnings).toEqual([expect.objectContaining({ code: 'source_unavailable', source: 'loans' })]);
  });

  it('any other error propagates (a code bug is not a warning)', async () => {
    const warnings: ForecastWarning[] = [];
    await expect(guardedSource('sp', 'loans', warnings, () => Promise.reject(new TypeError('bug')))).rejects.toThrow('bug');
    await expect(guardedSource('sp', 'x', warnings, () => Promise.reject(Object.assign(new Error('e'), { code: 'ENOENT' })))).rejects.toThrow('e');
    expect(warnings).toEqual([]);
  });

  it('passes a value through', async () => {
    expect(await guardedSource('sp', 'x', [], () => Promise.resolve(7))).toBe(7);
    expect(isDatabaseError({ code: '23505' })).toBe(true);
    expect(isDatabaseError({ code: 23505 })).toBe(false);
  });
});
