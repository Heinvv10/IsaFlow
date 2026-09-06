import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommentaryBlock } from '@/components/accounting/commentary/CommentaryBlock';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';

const rows: CommentaryRow[] = [
  { id: 'a', sectionRef: 'income_statement', rowRef: 'revenue', draftText: 'DRAFT REVENUE SENTENCE',
    approvedText: null, status: 'draft', approvedBy: null, approvedAt: null },
  { id: 'b', sectionRef: 'income_statement', rowRef: 'netProfit', draftText: 'OLD DRAFT',
    approvedText: 'APPROVED PROFIT SENTENCE', status: 'approved', approvedBy: 'u1', approvedAt: '2026-09-01T00:00:00Z' },
  { id: 'c', sectionRef: 'balance_sheet', rowRef: 'liquidity', draftText: 'OTHER SECTION',
    approvedText: null, status: 'draft', approvedBy: null, approvedAt: null },
];

describe('CommentaryBlock in published mode', () => {
  it('renders approved text only, never a draft', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={rows} mode="published" />);
    expect(screen.getByText('APPROVED PROFIT SENTENCE')).toBeTruthy();
    expect(screen.queryByText('DRAFT REVENUE SENTENCE')).toBeNull();
    expect(screen.queryByText('OLD DRAFT')).toBeNull();
  });

  it('renders nothing at all when the section has no approved text', () => {
    const { container } = render(
      <CommentaryBlock sectionRef="balance_sheet" rows={rows} mode="published" />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows no approve or reject control', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={rows} mode="published" onApprove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
});

describe('CommentaryBlock in published mode — a withdrawn approval', () => {
  // Migration 612: withdrawing an approval moves the row to 'draft' and LEAVES
  // approved_text in place, so the database still records who signed off.
  // `approvedText !== null` therefore no longer means "published", and the
  // status check is what keeps a withdrawn sentence off a shared link.
  const withdrawn: CommentaryRow[] = [
    { id: 'w', sectionRef: 'income_statement', rowRef: 'revenue', draftText: 'NEW DRAFT',
      approvedText: 'WITHDRAWN SENTENCE', status: 'draft', approvedBy: 'u1', approvedAt: '2026-09-01T00:00:00Z' },
  ];

  it('does not render text whose approval was taken back', () => {
    const { container } = render(
      <CommentaryBlock sectionRef="income_statement" rows={withdrawn} mode="published" />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('CommentaryBlock in internal mode', () => {
  it('shows the draft with an unpublished badge and an approve control', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={rows} mode="internal" onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText('DRAFT REVENUE SENTENCE')).toBeTruthy();
    expect(screen.getByText(/not published/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
  });

  it('shows approved text rather than the stale draft on an approved row', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={rows} mode="internal" onApprove={vi.fn()} />);
    expect(screen.getByText('APPROVED PROFIT SENTENCE')).toBeTruthy();
    expect(screen.queryByText('OLD DRAFT')).toBeNull();
  });

  it('does not show an approve control on an already-approved row', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={[rows[1]!]} mode="internal" onApprove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('calls onApprove with the row id', () => {
    const onApprove = vi.fn();
    render(<CommentaryBlock sectionRef="income_statement" rows={[rows[0]!]} mode="internal" onApprove={onApprove} />);
    screen.getByRole('button', { name: /approve/i }).click();
    expect(onApprove).toHaveBeenCalledWith('a');
  });
});
