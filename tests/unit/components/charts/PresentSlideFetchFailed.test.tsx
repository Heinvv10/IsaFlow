/**
 * A failed trends or budget-comparator fetch previously fell through to the
 * generic "This section has no presentation renderer yet" message — the
 * same text a genuinely unhandled slide kind gets. That message tells a
 * presenter "nothing to build here", when the truth is "the network call
 * failed". Mirrors the income-statement slide's own
 * "could not be loaded" pattern.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import type { Slide } from '@/components/accounting/present/presentSlides';

afterEach(cleanup);

const TRENDS_SLIDE: Slide = { id: 'trends:0', kind: 'trends', title: 'Trends', data: {} };
const RATIOS_SLIDE: Slide = { id: 'ratios:0', kind: 'ratios', title: 'Ratios', data: {} };

const BASE_PROPS = {
  income: null, trends: null, trendsFailed: false,
  budget: [], budgetedCount: 0, budgetFailed: false,
};

describe('PresentSlide distinguishes a failed fetch from no renderer', () => {
  it('shows a load-failure message for trends when the fetch failed', () => {
    const { container } = render(
      <PresentSlide slide={TRENDS_SLIDE} {...BASE_PROPS} trendsFailed />,
    );
    expect(container.textContent).toContain('trend data');
    expect(container.textContent).toContain('could not be loaded');
    expect(container.textContent).not.toContain('no presentation renderer');
  });

  it('still shows the generic message for trends when nothing failed (e.g. still loading)', () => {
    const { container } = render(
      <PresentSlide slide={TRENDS_SLIDE} {...BASE_PROPS} />,
    );
    expect(container.textContent).toContain('no presentation renderer');
  });

  it('shows a load-failure message for ratios when the budget fetch failed', () => {
    const { container } = render(
      <PresentSlide slide={RATIOS_SLIDE} {...BASE_PROPS} budgetFailed />,
    );
    expect(container.textContent).toContain('budget data');
    expect(container.textContent).toContain('could not be loaded');
    expect(container.textContent).not.toContain('no presentation renderer');
  });

  it('still shows the generic message for ratios when nothing failed and no budget was captured', () => {
    const { container } = render(
      <PresentSlide slide={RATIOS_SLIDE} {...BASE_PROPS} />,
    );
    expect(container.textContent).toContain('no presentation renderer');
  });
});
