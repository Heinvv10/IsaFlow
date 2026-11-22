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
  it('M1: a row no path eliminates says so, why, and that a manual elimination with a reason is needed (apart from the unmapped kind)', () => {
    render(<MirroredDroppedNotice rows={[unresolved]} />);
    const a = screen.getByRole('alert');
    expect(a.textContent).toMatch(/1 mirrored sale has no elimination/);
    expect(a.textContent).toMatch(/2026-12-30: Manual sale Dec \(R\s?2[\s ]?500\.00\): cut-off: different financial years/);
    expect(a.textContent).toMatch(/manual elimination with a reason/);
    expect(a.textContent).not.toMatch(/no group account mapped/);
  });

  it('both kinds are shown as two alerts, each with its own advice; the unmapped one keeps its words', () => {
    render(<MirroredDroppedNotice rows={[unmapped, unresolved]} />);
    const alerts = screen.getAllByRole('alert').map((x) => x.textContent ?? '');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatch(/1 mirrored elimination not applied: an account has no group account mapped/);
    expect(alerts[1]).toMatch(/1 mirrored sale has no elimination/);
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
