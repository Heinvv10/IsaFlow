/**
 * The posting-warnings notice (PR #688 rounds 5-6): every response shape a
 * dropped cost-centre pick arrives in; a title that says WHICH centre and WHY
 * (the toast clips its second line, which hid the whole warning); a count per
 * document (two bills dropping the same centre read as one); and nothing for
 * a response without a warning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { notify } from '@/utils/toast';
import {
  notifyPostingWarnings, postingWarningsByDocument, postingWarningsIn, postingWarningsNotice,
} from '@/components/accounting/postingWarningsNotice';

const W1 = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const W2 = 'Line 2: project PH was not applied — it belongs to another FNO than the line\'s CC1.';
const W3 = 'Line 3: cost centre FT was not applied — the line already carries its own CC1 or project.';
/** The toast's second line is one row of ~280px: longer than this and it is cut off. */
const FITS = 45;

describe('posting warnings notice', () => {
  beforeEach(() => vi.mocked(notify.warning).mockReset());

  it('reads data.warnings, data.claim.warnings and each data.results[] item as a document', () => {
    expect(postingWarningsByDocument({ data: { id: 'x', warnings: [W1, W2] } } as never)).toEqual([[W1, W2]]);
    expect(postingWarningsByDocument({ data: { claim: { id: 'c', warnings: [W1] } } })).toEqual([[W1]]);
    expect(postingWarningsByDocument({ data: { results: [{ warnings: [W1] }, {}, null, { warnings: [W1, W2] }] } }))
      .toEqual([[W1], [W1, W2]]);
  });

  it('reads an auto-post sweep\'s data.autoPost.warnings: one document per bank transaction', () => {
    const swept = { txId: 't', journalEntryId: 'j', warnings: [W1] };
    expect(postingWarningsByDocument({ data: { autoPost: { warnings: [swept, { ...swept, warnings: [W1, W2] }, null, { warnings: [] }] } } }))
      .toEqual([[W1], [W1, W2]]);
    expect(postingWarningsByDocument({ data: { autoPost: { warnings: [] } } })).toEqual([]);
    expect(postingWarningsByDocument({ data: { autoPost: { warnings: 'no' } } } as never)).toEqual([]);
    expect(notifyPostingWarnings({ data: { autoPost: { warnings: [swept, swept] } } })).toBe(2);
    expect(notify.warning).toHaveBeenCalledWith('Posted — cost centre OLD not applied (inactive)', '+1 more not applied, in 2 documents.');
  });

  it('merges a repeat inside one document only: two documents dropping the same centre are two', () => {
    expect(postingWarningsIn({ data: { warnings: [W1, W1] } })).toEqual([W1]);
    expect(postingWarningsIn({ data: { results: [{ warnings: [W1] }, { warnings: [W1] }] } })).toEqual([W1, W1]);
  });

  it('finds nothing in a response without warnings, or in one that is not a response', () => {
    for (const body of [{ data: { id: 'x' } }, { data: { warnings: [] } }, { data: { warnings: 'no' } }, { data: { warnings: [7, '', null] } },
      { data: null }, { success: false }, null, undefined, 'x']) {
      expect(postingWarningsIn(body as never), JSON.stringify(body)).toEqual([]);
    }
  });

  it('the title says which centre and why; the second line fits its one row', () => {
    expect(postingWarningsNotice([[W1]])).toEqual({ title: 'Posted — cost centre OLD not applied (inactive)', message: 'Line 1 posted without it.' });
    expect(postingWarningsNotice([[W2]]).title).toBe('Posted — project PH not applied (another FNO)');
    expect(postingWarningsNotice([[W3]]).title).toBe('Posted — cost centre FT not applied (the line has its own)');
    expect(postingWarningsNotice([[W1, W2, W3]])).toEqual({ title: 'Posted — cost centre OLD not applied (inactive)', message: '+2 more not applied.' });
    const many = postingWarningsNotice(Array.from({ length: 100 }, () => [W1, W2]));
    expect(many.message).toBe('+199 more not applied, in 100 documents.');
    for (const n of [postingWarningsNotice([[W1]]), postingWarningsNotice([[W1, W2, W3]]), many]) expect(n.message.length).toBeLessThanOrEqual(FITS);
  });

  it('a sentence it does not know is shown whole, in the title, which wraps', () => {
    expect(postingWarningsNotice([['Line 4: something new was not applied.']])).toEqual({ title: 'Posted — something new was not applied.', message: '' });
  });

  it('one warning toast per response, counted per document, and none without a warning', () => {
    expect(notifyPostingWarnings({ data: { warnings: [W1] } })).toBe(1);
    expect(notify.warning).toHaveBeenCalledWith('Posted — cost centre OLD not applied (inactive)', 'Line 1 posted without it.');
    vi.mocked(notify.warning).mockReset();
    // Two bills, the identical sentence: two dropped picks.
    expect(notifyPostingWarnings({ data: { results: [{ warnings: [W1] }, { warnings: [W1] }] } })).toBe(2);
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.warning).toHaveBeenCalledWith('Posted — cost centre OLD not applied (inactive)', '+1 more not applied, in 2 documents.');
    // One document, two picks: two as well (the count is of picks, not of documents).
    expect(notifyPostingWarnings({ data: { warnings: [W1, W2] } })).toBe(2);
    expect(notify.warning).toHaveBeenLastCalledWith('Posted — cost centre OLD not applied (inactive)', '+1 more not applied.');
    vi.mocked(notify.warning).mockReset();
    expect(notifyPostingWarnings({ data: { id: 'x' } } as never)).toBe(0);
    expect(notify.warning).not.toHaveBeenCalled();
  });
});
