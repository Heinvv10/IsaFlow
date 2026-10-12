/**
 * An auto-post sweep's warnings name the bank line each belongs to (`label`:
 * date and amount). The notice puts the first in the TITLE, which wraps — the
 * toast clips its second line — and names the others on line 2 as far as 45
 * characters allow, then "… and N more". It never prints the journal line
 * number: beside "bank line …" it reads as the statement's line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { notify } from '@/utils/toast';
import { formatCurrency } from '@/utils/formatters';
import { notifyPostingWarnings, postingWarningsByDocument, postingWarningsNotice } from '@/components/accounting/postingWarningsNotice';

const W1 = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const FACT = 'cost centre OLD not applied (inactive)';
const FITS = 45;
const swept = (txId: string, label: string | undefined, warnings: string[] = [W1]) => ({ txId, journalEntryId: `je-${txId}`, ...(label ? { label } : {}), warnings });
const body = (...docs: unknown[]) => ({ data: { autoPost: { warnings: docs as never } } });
const shown = () => vi.mocked(notify.warning).mock.calls[0]!;

describe('posting warnings notice — the bank line', () => {
  beforeEach(() => vi.mocked(notify.warning).mockReset());

  it('one line: named in the title, and line 2 does not print the journal line number', () => {
    expect(notifyPostingWarnings(body(swept('t1', '2026-09-12 R 1 234 567,89')))).toBe(1);
    const [title, message] = shown();
    expect(title).toBe(`Posted — ${FACT}, bank line 2026-09-12 R 1 234 567,89`);
    expect(message).toBeUndefined(); // not "Line 1 posted without it." — that is the journal's line, always 1
  });

  it('several lines: line 2 names the next ones, then "… and N more", always within one row', () => {
    const labels = ['2026-09-08 R 500,00', '2026-09-12 R 1 234 567,89', '2026-09-13 R 10,00', '2026-09-14 R 20,00', '2026-09-15 R 30,00'];
    notifyPostingWarnings(body(swept('t1', labels[0]), swept('t2', labels[1])));
    expect(shown()[1]).toBe('+1 more: 2026-09-12 R 1 234 567,89');
    vi.mocked(notify.warning).mockReset();
    notifyPostingWarnings(body(...labels.map((l, i) => swept(`t${i}`, l))));
    const [title, message] = shown();
    expect(title).toContain('bank line 2026-09-08 R 500,00');
    expect(message).toBe('+4 more: 2026-09-12 R 1 234 567,89 …'); // "… and 3 more" would not fit beside the name
    vi.mocked(notify.warning).mockReset();
    notifyPostingWarnings(body(...['2026-09-08 R 5,00', '2026-09-12 R 9,00', '2026-09-13 R 1,00', '2026-09-14 R 2,00', '2026-09-15 R 3,00'].map((l, i) => swept(`s${i}`, l))));
    expect(shown()[1]).toBe('+4 more: 2026-09-12 R 9,00 … and 3 more');
    for (const n of [2, 3, 4, 5, 40]) {
      vi.mocked(notify.warning).mockReset();
      notifyPostingWarnings(body(...Array.from({ length: n }, (_, i) => swept(`t${i}`, `2026-09-${10 + (i % 18)} R 1 234 567,89`))));
      expect((shown()[1] as string).length, `${n} lines`).toBeLessThanOrEqual(FITS);
    }
  });

  it('when not even one more name fits, it says how many', () => {
    expect(postingWarningsNotice([[W1], [W1]], ['2026-09-08 R 500,00', `2026-09-12 R ${'9'.repeat(40)}`]).message).toBe('+1 more not applied.');
  });

  it('names the first document that has warnings, not the first in the list', () => {
    notifyPostingWarnings(body(swept('t0', '2026-10-01 R 1,00', []), swept('t2', '2026-10-03 R 115,00')));
    expect(shown()[0]).toContain('bank line 2026-10-03 R 115,00');
  });

  it('a document with no label reads as it did', () => {
    notifyPostingWarnings(body(swept('t1', undefined)));
    expect(shown()).toEqual([`Posted — ${FACT}`, 'Line 1 posted without it.']);
    expect(postingWarningsNotice([[W1]]).title).toBe(`Posted — ${FACT}`);
  });

  it('the label is the app\'s currency format, thousands and all', () => {
    expect(formatCurrency(1234567.89)).toMatch(/^R\s1\s234\s567,89$/u);
  });

  it('keeps the document-by-document reading unchanged', () => {
    expect(postingWarningsByDocument(body(swept('t1', 'x'), swept('t2', 'y', [])))).toEqual([[W1]]);
  });
});
