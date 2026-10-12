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
    expect(many.message).toBe('+199 more, in 100 documents');
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
    expect(notify.warning).toHaveBeenCalledWith('Posted — cost centre OLD not applied (inactive)', '+1 more, in 2 documents');
    // One document, two picks: two as well (the count is of picks, not of documents).
    expect(notifyPostingWarnings({ data: { warnings: [W1, W2] } })).toBe(2);
    expect(notify.warning).toHaveBeenLastCalledWith('Posted — cost centre OLD not applied (inactive)', '+1 more not applied.');
    vi.mocked(notify.warning).mockReset();
    expect(notifyPostingWarnings({ data: { id: 'x' } } as never)).toBe(0);
    expect(notify.warning).not.toHaveBeenCalled();
  });

  it('names the bills in the second line, and degrades predictably when the numbers do not fit', () => {
    const docs = (n: number) => Array.from({ length: n }, () => [W1]);
    const name = (n: number) => Array.from({ length: n }, (_, i) => `INV-${i + 1}`);
    const line = (n: number, names: Array<string | undefined>) => postingWarningsNotice(docs(n), names).message;
    expect(line(2, name(2))).toBe('+1 more, in INV-1, INV-2');
    expect(line(3, name(3))).toBe('+2 more, in INV-1, INV-2, INV-3');
    expect(line(5, name(5))).toBe('+4 more, in INV-1, INV-2, INV-3, INV-4, INV-5'); // exactly 45
    expect(line(8, name(8))).toBe('+7 more, in INV-1, INV-2, INV-3 and 5 more');
    expect(line(100, name(100))).toBe('+99 more, in INV-1, INV-2, INV-3 and 97 more');
    // A number too long to share the row, and a number the response did not carry: just how many.
    expect(line(2, ['SUPPLIER-ACCOUNT-2026-10-INVOICE-0001', 'B'])).toBe('+1 more, in 2 documents');
    expect(line(2, ['INV-1', undefined])).toBe('+1 more, in 2 documents');
    for (const names of [name(2), name(3), name(8), name(100), ['X'.repeat(80), 'Y'.repeat(80)]]) {
      const n = postingWarningsNotice(docs(names.length), names);
      expect(n.message.length, n.message).toBeLessThanOrEqual(FITS);
      expect(n.title).toBe('Posted — cost centre OLD not applied (inactive)');
    }
  });

  it('reads the number each bulk result carries, per document', () => {
    notifyPostingWarnings({ data: { results: [
      { invoiceNumber: 'INV-12', warnings: [W1] }, { invoiceNumber: 'INV-99' }, { invoiceNumber: 'INV-13', warnings: [W1] },
    ] } });
    expect(notify.warning).toHaveBeenCalledWith('Posted — cost centre OLD not applied (inactive)', '+1 more, in INV-12, INV-13');
  });
});
