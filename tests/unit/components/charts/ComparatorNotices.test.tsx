import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  ComparatorNotices, comparatorNotices, BUDGET_NONE, BUDGET_FAILED, TREND_FAILED,
} from '@/components/accounting/reportControls/ComparatorNotices';

afterEach(cleanup);

describe('comparatorNotices', () => {
  it('says nothing while every comparator is behaving', () => {
    expect(comparatorNotices({ budgetState: 'available', trendFailed: false })).toEqual([]);
    expect(comparatorNotices({ budgetState: 'unknown', trendFailed: false })).toEqual([]);
  });

  it('distinguishes a budget that was never captured from one that would not load', () => {
    // Both render an empty Budget column. Only one of them is a statement
    // about the period, and showing the wrong sentence tells the reader the
    // company has no budget when in fact nobody knows.
    const none = comparatorNotices({ budgetState: 'none', trendFailed: false });
    const failed = comparatorNotices({ budgetState: 'failed', trendFailed: false });
    expect(none).toEqual([{ tone: 'info', text: BUDGET_NONE }]);
    expect(failed).toEqual([{ tone: 'error', text: BUDGET_FAILED }]);
    expect(none[0]!.text).not.toBe(failed[0]!.text);
  });

  it('reports a failed trend fetch, which otherwise looks like an account with no series', () => {
    expect(comparatorNotices({ budgetState: 'unknown', trendFailed: true }))
      .toEqual([{ tone: 'error', text: TREND_FAILED }]);
  });

  it('reports both failures at once rather than only the first', () => {
    expect(comparatorNotices({ budgetState: 'failed', trendFailed: true })).toHaveLength(2);
  });
});

describe('<ComparatorNotices />', () => {
  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<ComparatorNotices budgetState="available" trendFailed={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('gives a failure the alert role so a screen reader announces it', () => {
    render(<ComparatorNotices budgetState="failed" trendFailed={false} />);
    expect(screen.getByRole('alert').textContent).toBe(BUDGET_FAILED);
  });

  it('does not shout about a legitimately absent budget', () => {
    render(<ComparatorNotices budgetState="none" trendFailed={false} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(BUDGET_NONE)).toBeInTheDocument();
  });
});
