/**
 * Round 21: what the consolidated reports and the Eliminations page say about mirrored rows the group figures keep un-eliminated
 * (M1: a row no path eliminates is listed, with its reason, apart from the unmapped-account kind) and about the income-statement
 * elimination window when the members' years start on different dates (L7).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MirroredDroppedNotice, parseDroppedMirrored } from '@/components/accounting/group/MirroredDroppedNotice';
import { TBConsolidationWarnings } from '@/components/accounting/group/TBConsolidationWarnings';

afterEach(cleanup);

const unmapped = { transactionId: 't1', keyDate: '2026-01-15', description: 'Automatic: mirrored intercompany documents - Invoice X', amount: 1000, kind: 'unmapped' as const, detail: '' };
const unresolved = { transactionId: 't2', keyDate: '2026-12-30', description: 'Manual sale Dec', amount: 2500, kind: 'unresolved' as const, detail: 'cut-off: different financial years' };

describe('MirroredDroppedNotice', () => {
  it('M1: a row no path eliminates says so and why (apart from the unmapped kind)', () => {
    render(<MirroredDroppedNotice rows={[unresolved]} />);
    const a = screen.getByRole('alert');
    expect(a.textContent).toMatch(/1 mirrored document has no elimination/);
    expect(a.textContent).toMatch(/2026-12-30: Manual sale Dec \(R\s?2[\s ]?500\.00\): cut-off: different financial years/);
    expect(a.textContent).not.toMatch(/no group account mapped/);
  });

  it('both kinds are shown as two alerts, each with its own advice; the unmapped one keeps its words', () => {
    render(<MirroredDroppedNotice rows={[unmapped, unresolved]} />);
    const alerts = screen.getAllByRole('alert').map((x) => x.textContent ?? '');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatch(/1 mirrored elimination not applied: an account has no group account mapped/);
    expect(alerts[1]).toMatch(/1 mirrored document has no elimination/);
  });

  it('the listing is informational: it says nothing eliminates these, that eliminating by hand is not available yet, and offers no action', () => {
    render(<MirroredDroppedNotice rows={[unresolved]} />);
    const a = screen.getByRole('alert');
    expect(a.textContent).toMatch(/No path eliminates these/);
    expect(a.textContent).toMatch(/Eliminating a mirrored row by hand is not available yet/);
    expect(a.textContent).not.toMatch(/Eliminate this row|manual elimination with a reason/);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it.each([
    ['variance', /Fix: the receiver corrects or re-books its document so that it carries the sender's figures in the same financial year, or the sender cancels or credits the sale\./],
    ['cancelled', /Fix: the receiver books its document again, or the sender cancels or credits the sale\./],
    ['rejected', /Fix: the receiver booked no expense for this sale\. A rejection is final: the sale returns to the sender's outbox, where it is corrected and sent again, or the sender cancels the sale\./],
    ['dismissed', /Fix: the receiver booked no expense for this sale\. It can restore the message and accept it, or the sender cancels the sale\./],
    ['failed', /Fix: the receiver booked no expense for this sale\. It can accept the message itself, or the sender cancels the sale\./],
  ])('says what fixes a %s row, and none of it is a manual elimination', (code, fix) => {
    render(<MirroredDroppedNotice rows={[{ ...unresolved, code }]} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(fix);
    expect(text).not.toMatch(/by hand must then be reversed|Make a manual elimination/);
  });

  it('a credit note is worded as one, not as a sale', () => {
    render(<MirroredDroppedNotice rows={[{ ...unresolved, amount: -400, code: 'rejected', detail: 'the receiver rejected it' }]} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(/the credit note returns to the sender's outbox/);
    expect(text).not.toMatch(/the sale returns/);
  });

  it('nothing is shown for no rows; a body without a kind parses as the unmapped kind (older payloads)', () => {
    const { container } = render(<MirroredDroppedNotice rows={[]} />);
    expect(container.textContent).toBe('');
    expect(parseDroppedMirrored({ droppedMirrored: [{ transactionId: 't', amount: 5 }, { transactionId: 7 }] })).toEqual([
      { transactionId: 't', keyDate: '', description: '', amount: 5, kind: 'unmapped', detail: '' }]);
    expect(parseDroppedMirrored({ data: { droppedMirrored: [{ ...unresolved }] } })[0]).toMatchObject({ kind: 'unresolved', detail: 'cut-off: different financial years' });
  });
});

describe('TBConsolidationWarnings: the elimination window (L7)', () => {
  const note = 'The members\' years start on different dates: the income-statement eliminations run from 2025-03-01 (the earliest year start) to 2026-02-28.';
  it('shows the note with the non-coterminous warning, and only there', () => {
    const { rerender } = render(<TBConsolidationWarnings coterminous={false} eliminationsNote={note} />);
    expect(screen.getByText(/Members do not share a financial year end/)).toBeTruthy();
    expect(screen.getByText(note)).toBeTruthy();
    rerender(<TBConsolidationWarnings coterminous eliminationsNote={null} />);
    expect(screen.queryByText(/earliest year start/)).toBeNull();
  });
});
