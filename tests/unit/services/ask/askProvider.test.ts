import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveProvider } from '@/modules/accounting/services/ask/askProvider';

afterEach(() => vi.unstubAllGlobals());

describe('free-text provider seam', () => {
  it.each([undefined, '', '  ', 'openai', 'anthropic', 'constructor', '__proto__', 'toString'])('%j is off', (v) => {
    expect(resolveProvider({ ASK_ISAFLOW_PROVIDER: v })).toBeNull();
  });
  it('is off with the real environment and attempts no fetch', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(resolveProvider()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
