/**
 * The posting-warnings notice (PR #688 round 5): every response shape a
 * dropped cost-centre pick arrives in, one warning toast per response, and
 * nothing for a response without one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { notify } from '@/utils/toast';
import { notifyPostingWarnings, postingWarningsIn, postingWarningsMessage } from '@/components/accounting/postingWarningsNotice';

const W1 = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const W2 = 'Line 2: project PH was not applied — it belongs to another FNO than the line\'s CC1.';

describe('posting warnings notice', () => {
  beforeEach(() => vi.mocked(notify.warning).mockReset());

  it('reads data.warnings, data.claim.warnings and data.results[].warnings, once each', () => {
    expect(postingWarningsIn({ data: { id: 'x', warnings: [W1, W2] } })).toEqual([W1, W2]);
    expect(postingWarningsIn({ data: { claim: { id: 'c', warnings: [W1] } } })).toEqual([W1]);
    expect(postingWarningsIn({ data: { results: [{ ok: true, warnings: [W1] }, { ok: true }, null, { ok: true, warnings: [W1, W2] }] } }))
      .toEqual([W1, W2]);
  });

  it('finds nothing in a response without warnings, or in one that is not a response', () => {
    for (const body of [{ data: { id: 'x' } }, { data: { warnings: [] } }, { data: { warnings: 'no' } }, { data: { warnings: [7, '', null] } },
      { data: null }, { success: false }, null, undefined, 'x']) {
      expect(postingWarningsIn(body), JSON.stringify(body)).toEqual([]);
    }
  });

  it('shows the first three sentences and counts the rest', () => {
    expect(postingWarningsMessage([W1])).toBe(W1);
    expect(postingWarningsMessage(['a.', 'b.', 'c.', 'd.', 'e.'])).toBe('a. b. c. (+2 more)');
  });

  it('one warning toast per response, saying how many, and none without a warning', () => {
    expect(notifyPostingWarnings({ data: { warnings: [W1] } })).toBe(1);
    expect(notify.warning).toHaveBeenCalledWith('Posted — 1 cost centre was not applied', W1);
    vi.mocked(notify.warning).mockReset();
    expect(notifyPostingWarnings({ data: { results: [{ warnings: [W1] }, { warnings: [W2] }] } })).toBe(2);
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.warning).toHaveBeenCalledWith('Posted — 2 cost centres were not applied', `${W1} ${W2}`);
    vi.mocked(notify.warning).mockReset();
    expect(notifyPostingWarnings({ data: { id: 'x' } })).toBe(0);
    expect(notify.warning).not.toHaveBeenCalled();
  });
});
