import { describe, it, expect } from 'vitest';
import { parseSharePackParams } from '@/modules/accounting/services/share/shareParams';

describe('parseSharePackParams', () => {
  it('accepts the three pack types with ISO dates', () => {
    expect(parseSharePackParams({ type: 'board', from: '2026-03-01', to: '2026-08-31' }))
      .toEqual({ type: 'board', from: '2026-03-01', to: '2026-08-31' });
    expect(parseSharePackParams({ type: 'management', from: '2026-03-01', to: '2026-08-31' })).not.toBeNull();
    expect(parseSharePackParams({ type: 'monthly', from: '2026-03-01', to: '2026-08-31' })).not.toBeNull();
  });

  it('drops any extra key rather than carrying it into the stored params', () => {
    expect(parseSharePackParams({ type: 'board', from: '2026-03-01', to: '2026-08-31', companyId: 'other-tenant' }))
      .toEqual({ type: 'board', from: '2026-03-01', to: '2026-08-31' });
  });

  it('rejects an unknown type, a bad date, a reversed range, and a non-object', () => {
    expect(parseSharePackParams({ type: 'annual', from: '2026-03-01', to: '2026-08-31' })).toBeNull();
    expect(parseSharePackParams({ type: 'board', from: '01/03/2026', to: '2026-08-31' })).toBeNull();
    expect(parseSharePackParams({ type: 'board', from: '2026-08-31', to: '2026-03-01' })).toBeNull();
    expect(parseSharePackParams(null)).toBeNull();
    expect(parseSharePackParams('board')).toBeNull();
  });
});
