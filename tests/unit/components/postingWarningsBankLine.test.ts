/**
 * An auto-post sweep's warnings name the bank line each belongs to (`label`:
 * date and amount). The notice puts it in the TITLE, which wraps — the toast
 * clips its second line — so the person can tell WHICH line posted without its
 * cost centre. Documents with no label (bills, claims) read as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { notify } from '@/utils/toast';
import { notifyPostingWarnings, postingWarningsByDocument, postingWarningsNotice } from '@/components/accounting/postingWarningsNotice';

const W1 = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const FITS = 45;
const swept = (txId: string, label: string | undefined, warnings: string[] = [W1]) => ({ txId, journalEntryId: `je-${txId}`, ...(label ? { label } : {}), warnings });

describe('posting warnings notice — the bank line', () => {
  beforeEach(() => vi.mocked(notify.warning).mockReset());

  it('names the bank line in the title, and keeps the second line short', () => {
    expect(notifyPostingWarnings({ data: { autoPost: { warnings: [swept('t1', '2026-10-02 R230.00')] } } })).toBe(1);
    expect(notify.warning).toHaveBeenCalledWith(
      'Posted — cost centre OLD not applied (inactive), bank line 2026-10-02 R230.00', 'Line 1 posted without it.',
    );
    vi.mocked(notify.warning).mockReset();
    notifyPostingWarnings({ data: { autoPost: { warnings: [swept('t1', '2026-10-02 R230.00'), swept('t2', '2026-10-03 R115.00')] } } });
    // Several lines: the title names the first, the second line counts the rest.
    expect(notify.warning).toHaveBeenCalledWith(
      'Posted — cost centre OLD not applied (inactive), bank line 2026-10-02 R230.00', '+1 more not applied, in 2 documents.',
    );
    for (const [, message] of vi.mocked(notify.warning).mock.calls) expect((message as string).length).toBeLessThanOrEqual(FITS);
  });

  it('names the first document that has warnings, not the first in the list', () => {
    notifyPostingWarnings({ data: { autoPost: { warnings: [swept('t0', '2026-10-01 R1.00', []), swept('t2', '2026-10-03 R115.00')] } } });
    expect(notify.warning).toHaveBeenCalledWith(expect.stringContaining('bank line 2026-10-03 R115.00'), 'Line 1 posted without it.');
  });

  it('a document with no label reads as it did', () => {
    notifyPostingWarnings({ data: { autoPost: { warnings: [swept('t1', undefined)] } } });
    expect(notify.warning).toHaveBeenCalledWith('Posted — cost centre OLD not applied (inactive)', 'Line 1 posted without it.');
    expect(postingWarningsNotice([[W1]]).title).toBe('Posted — cost centre OLD not applied (inactive)');
  });

  it('keeps the document-by-document reading unchanged', () => {
    expect(postingWarningsByDocument({ data: { autoPost: { warnings: [swept('t1', 'x'), swept('t2', 'y', [])] } } })).toEqual([[W1]]);
  });
});
