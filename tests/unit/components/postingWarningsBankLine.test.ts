/**
 * An auto-post sweep's warnings name the bank line each belongs to (`label`).
 * The notice is a POINTER: the title names the first drop, line 2 says how many
 * more and where to look (the import screen lists every bank line). Line 2 has
 * no label to overflow the toast's one row, and counts WARNINGS, not lines:
 * one bank line can carry several.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { notify } from '@/utils/toast';
import { notifyPostingWarnings, postingWarningFact, postingWarningsByDocument, postingWarningsNotice } from '@/components/accounting/postingWarningsNotice';

const W1 = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const W2 = 'Line 2: project PH was not applied — it belongs to another FNO than the line\'s CC1.';
const FACT = 'cost centre OLD not applied (inactive)';
/** Measured in DM Sans at the toast's 280px (f3brk3): a digit-heavy string of 40 never overflowed, 44-45 did. */
const FITS = 40;
const swept = (txId: string, label: string | undefined, warnings: string[] = [W1]) => ({ txId, journalEntryId: `je-${txId}`, ...(label ? { label } : {}), warnings });
const body = (...docs: unknown[]) => ({ data: { autoPost: { warnings: docs as never } } });
const shown = () => vi.mocked(notify.warning).mock.calls[0]!;

describe('posting warnings notice — the bank line', () => {
  beforeEach(() => vi.mocked(notify.warning).mockReset());

  it('one drop: the fact and the bank line in the title, a pointer on line 2 (never the journal line number)', () => {
    expect(notifyPostingWarnings(body(swept('t1', '2026-09-12 R 1 234 567,89')))).toBe(1);
    expect(shown()).toEqual([`Posted — ${FACT}, bank line 2026-09-12 R 1 234 567,89`, 'See the list below.']);
  });

  it('several: line 2 counts the others and points to the list; it names no label and no amount', () => {
    notifyPostingWarnings(body(swept('t1', '2026-09-08 R 500,00'), swept('t2', '2026-09-12 R 1 234 567,89'), swept('t3', '2026-09-13 R 10,00')));
    const [title, message] = shown();
    expect(title).toContain('bank line 2026-09-08 R 500,00');
    expect(message).toBe('+2 more warnings — listed below');
    expect(message).not.toMatch(/R\s|2026/);
  });

  it('line 2 stays within 40 characters for any count', () => {
    for (const n of [1, 2, 9, 10, 99, 100, 999, 9999, 99999]) {
      expect(postingWarningsNotice([[W1], ...Array.from({ length: n }, () => [W1])], Array.from({ length: n + 1 }, () => '2026-09-08 R 500,00')).message.length, `${n}`).toBeLessThanOrEqual(FITS);
    }
  });

  it('counts every warning: a bank line with two is "+1 more", not nothing', () => {
    expect(postingWarningsNotice([[W1, W2]], ['2026-09-08 R 500,00']).message).toBe('+1 more warning — listed below');
    expect(postingWarningsNotice([[W1, W2], [W1]], ['2026-09-08 R 500,00', '2026-09-09 R 1,00']).message).toBe('+2 more warnings — listed below');
  });

  it('names the first document that has warnings, not the first in the list', () => {
    notifyPostingWarnings(body(swept('t0', '2026-10-01 R 1,00', []), swept('t2', '2026-10-03 R 115,00')));
    expect(shown()[0]).toContain('bank line 2026-10-03 R 115,00');
  });

  it('a sweep line with no label has no bank line in the title, but line 2 still points at the list', () => {
    notifyPostingWarnings(body(swept('t1', undefined)));
    expect(shown()).toEqual([`Posted — ${FACT}`, 'See the list below.']);
    vi.mocked(notify.warning).mockReset();
    notifyPostingWarnings(body(swept('t1', undefined), swept('t2', '2026-09-08 R 1,00')));
    expect(shown()).toEqual([`Posted — ${FACT}`, '+1 more warning — listed below']);
  });

  it('a document that is not a bank line (a bill, a claim) reads as it did', () => {
    notifyPostingWarnings({ data: { warnings: [W1] } });
    expect(shown()).toEqual([`Posted — ${FACT}`, 'Line 1 posted without it.']);
    expect(postingWarningsNotice([[W1]]).title).toBe(`Posted — ${FACT}`);
  });

  it('postingWarningFact is the short form of a sentence, and a sentence it does not know whole', () => {
    expect(postingWarningFact(W1)).toBe(FACT);
    expect(postingWarningFact(W2)).toBe('project PH not applied (another FNO)');
    expect(postingWarningFact('Line 4: something new happened.')).toBe('something new happened.');
  });

  it('keeps the document-by-document reading unchanged', () => {
    expect(postingWarningsByDocument(body(swept('t1', 'x'), swept('t2', 'y', [])))).toEqual([[W1]]);
  });
});
