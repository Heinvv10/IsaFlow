/**
 * The presentation's budget slide says WHY the comparator has no budget (Codex
 * P2 on PR #950). With `partialWindow: 'absent'` a deck window ending mid-month
 * answers `budgetedCount: 0` with `splitsMonth: true` even when budgets exist;
 * "No budget was captured" is then untrue. It is said only when no withholding
 * reason applies.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import { BUDGET_WHOLE_MONTHS, type BudgetInfo } from '@/components/accounting/reportControls/ComparatorNotices';
import type { Slide } from '@/components/accounting/present/presentSlides';

afterEach(cleanup);

const SLIDE: Slide = { id: 'ratios:0', kind: 'ratios', title: 'Ratios', data: {} };
const INFO: BudgetInfo = {
  budgetAbsentYears: [], budgetOutsideFilterYears: [], unallocatedBudget: { income: 0, expense: 0 },
  partialBudgetCount: 0, splitsMonth: false, retryAfterSecs: null, rejection: null,
};

const slide = (budgetInfo?: BudgetInfo) => render(
  <PresentSlide slide={SLIDE} income={null} trends={null} trendsFailed={false}
    budget={[]} budgetedCount={0} budgetInfo={budgetInfo} budgetFailed={false} />,
).container.textContent ?? '';

describe('PresentSlide budget slide absence reason', () => {
  it('a window ending mid-month explains the whole-month rule, not "no budget was captured"', () => {
    const text = slide({ ...INFO, splitsMonth: true });
    expect(text).toContain(BUDGET_WHOLE_MONTHS);
    expect(text).not.toContain('No budget was captured');
  });

  it('a partial-only window names its partial accounts, not "no budget was captured"', () => {
    const text = slide({ ...INFO, partialBudgetCount: 2 });
    expect(text).toContain('2 accounts have a budget for only part of this window');
    expect(text).not.toContain('No budget was captured');
  });

  it('no withholding reason (or no info) still says no budget was captured', () => {
    expect(slide(INFO)).toContain('No budget was captured for this period.');
    expect(slide()).toContain('No budget was captured for this period.');
  });
});
