import { describe, it, expect } from 'vitest';
import { toneString } from '@/lib/theme/toneStrings';

describe('toneString', () => {
  it('renders terse copy for practitioner', () => {
    expect(toneString('reconcileCta', 'practitioner', { count: 14 })).toBe('Reconcile 14');
  });

  it('renders warm copy for client', () => {
    expect(toneString('reconcileCta', 'client', { count: 14 })).toBe('14 things to tidy up');
  });

  it('falls back to the key when an unknown key is requested', () => {
    expect(toneString('nope' as never, 'client', { count: 1 })).toBe('nope');
  });

  it('handles singular/plural via the count var', () => {
    expect(toneString('reconcileCta', 'client', { count: 1 })).toBe('1 thing to tidy up');
  });
});
