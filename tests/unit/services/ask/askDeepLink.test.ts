import { describe, it, expect } from 'vitest';
import { readDeepLinkPeriod } from '@/components/accounting/sars/useReturnDeepLink';

describe('return page deep link', () => {
  it('reads a real, ordered from/to', () => {
    expect(readDeepLinkPeriod({ from: '2026-09-01', to: '2026-10-31' })).toEqual({ from: '2026-09-01', to: '2026-10-31' });
  });
  it.each([
    [{}], [{ from: '2026-09-01' }], [{ from: '2026-13-01', to: '2026-10-31' }], [{ from: '2026-10-31', to: '2026-09-01' }],
    [{ from: ['2026-09-01'], to: '2026-10-31' }], [{ from: 'x', to: 'y' }],
  ])('%j is ignored whole', (q) => expect(readDeepLinkPeriod(q as Record<string, string>)).toBeNull());
});
