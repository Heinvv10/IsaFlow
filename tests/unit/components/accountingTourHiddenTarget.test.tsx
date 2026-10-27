/**
 * A tour step whose target is hidden at this width (the top nav tabs below lg) measures 0x0 at the top-left corner.
 * The tour must treat it as no target and centre the step, not spotlight an empty corner.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })),
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (_e: unknown, m: string) => m,
}));

import { AccountingTour } from '@/components/onboarding/AccountingTour';
import { TOUR_STEPS } from '@/components/onboarding/tourConfig';

let target: HTMLElement | null = null;
afterEach(() => { cleanup(); target?.remove(); target = null; localStorage.clear(); });

function addTarget(rect: { width: number; height: number }) {
  const selector = TOUR_STEPS[0]!.target; // e.g. [data-tour="dashboard"]
  const m = /\[data-tour="([^"]+)"\]/.exec(selector);
  target = document.createElement('div');
  if (m) target.setAttribute('data-tour', m[1]!);
  target.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: rect.width, bottom: rect.height, ...rect, toJSON: () => ({}) });
  document.body.appendChild(target);
}

const highlight = () => document.querySelector('.border-teal-400');

describe('AccountingTour target measuring', () => {
  it('centres the step when its target is hidden (0x0)', async () => {
    addTarget({ width: 0, height: 0 });
    render(<AccountingTour />);
    await screen.findByText(TOUR_STEPS[0]!.title);
    expect(highlight()).toBeNull();
  });

  it('spotlights a visible target', async () => {
    addTarget({ width: 120, height: 40 });
    render(<AccountingTour />);
    await screen.findByText(TOUR_STEPS[0]!.title);
    expect(highlight()).not.toBeNull();
  });
});
