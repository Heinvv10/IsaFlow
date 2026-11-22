/**
 * Round 26, M2: a row the auto-generator did NOT draft because the SENDER cancelled its sale is listed apart from the rows a mirrored document
 * eliminates (it says there is no revenue left to eliminate, never that a mirror eliminates it).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EliminationsFlaggedNotice, parseSkipped, type SkippedRow } from '@/components/accounting/group/EliminationsFlaggedNotice';

afterEach(cleanup);

const row = (over: Partial<SkippedRow> = {}): SkippedRow => ({ transactionId: 't1', reason: 'eliminated by mirroring (INV-1)', cutover: '2026-03-01', mirroredRef: 'INV-1',
  detail: 'eliminated automatically and is matched to this row', description: 'Manual sale', date: '2026-04-10', amount: 1000, ...over });
const CANCELLED = { transactionId: 't2', reason: 'cancelled by the sender', mirroredRef: 'INV-2', detail: 'the sender cancelled it; there is no revenue left to eliminate', senderCancelled: true };

describe('the skipped rows of an auto-generate run', () => {
  it('a row the sender cancelled is listed under its own sentence, with the generator\'s words', () => {
    render(<EliminationsFlaggedNotice rows={[]} skipped={[row(CANCELLED)]} onDismiss={() => {}} />);
    const n = screen.getByRole('status', { name: 'Auto-generate notes' });
    expect(n.textContent).toMatch(/1 intercompany row was not drafted: the sender cancelled its sale, so there is no revenue left to eliminate\./);
    expect(n.textContent).toMatch(/mirrored document INV-2, the sender cancelled it; there is no revenue left to eliminate/);
    expect(n.textContent).not.toMatch(/a mirrored document of the pair eliminates/);
  });

  it('a mirror-eliminated row and a cancelled one are told apart', () => {
    render(<EliminationsFlaggedNotice rows={[]} skipped={[row(), row(CANCELLED)]} onDismiss={() => {}} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/1 intercompany row was not drafted: a mirrored document of the pair eliminates it\./);
    expect(text).toMatch(/1 intercompany row was not drafted: the sender cancelled its sale/);
    expect(text).toMatch(/mirrored document INV-1, which is eliminated automatically and is matched to this row/);
  });

  it('parseSkipped keeps senderCancelled', () => {
    expect(parseSkipped({ data: { skipped: [{ ...CANCELLED, cutover: 'c' }, { transactionId: 'x', reason: 'r' }] } }).map((r) => r.senderCancelled)).toEqual([true, false]);
  });
});
