/**
 * isaflow.co.za's landing page: the live stats come from getStaticProps (ISR),
 * the unverified testimonials and "trusted by" strip are gone, and pricing
 * still renders unchanged.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetStaticPropsContext } from 'next';

const getLandingStats = vi.fn();
vi.mock('@/lib/landing/landingStats', () => ({ getLandingStats: () => getLandingStats() }));

import LandingPage, { getStaticProps } from '../../../pages/index';
import { PRICING_TIERS } from '@/components/landing/landingData';

const STATS = { transactionAmount: 146_234_567.89, businessCount: 7, invoiceCount: 6612 };

beforeEach(() => { getLandingStats.mockReset(); });
afterEach(() => { cleanup(); });

describe('landing page getStaticProps', () => {
  it('passes the live stats and revalidates hourly', async () => {
    getLandingStats.mockResolvedValue(STATS);
    await expect(getStaticProps({} as GetStaticPropsContext)).resolves.toEqual({ props: { stats: STATS }, revalidate: 3600 });
  });

  it('builds with null stats and retries soon when the DB is unreachable', async () => {
    getLandingStats.mockResolvedValue(null);
    await expect(getStaticProps({} as GetStaticPropsContext)).resolves.toEqual({ props: { stats: null }, revalidate: 60 });
  });
});

describe('landing page content', () => {
  it('renders the live stats into the page', () => {
    render(<LandingPage stats={STATS} />);
    expect(screen.getByText('R 146M+')).toBeTruthy();
  });

  it('has no testimonials or trust strip', () => {
    const { container } = render(<LandingPage stats={STATS} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Trusted by businesses worldwide');
    expect(text).not.toContain('Testimonials');
    expect(text).not.toContain('Loved by finance teams');
    for (const name of ['Thandi Molefe', 'Johan van der Merwe', 'Priya Naidoo', 'TechBridge Solutions', 'VDM Construction', 'SA Retail Group']) {
      expect(text).not.toContain(name);
    }
    expect(container.querySelector('#testimonials')).toBeNull();
    expect(container.querySelector('a[href="/#testimonials"]')).toBeNull();
  });

  it('still renders every pricing tier', () => {
    const { container } = render(<LandingPage stats={null} />);
    const pricing = container.querySelector('#pricing');
    expect(pricing).not.toBeNull();
    const text = pricing?.textContent ?? '';
    expect(PRICING_TIERS.map((t) => [t.name, t.price])).toEqual([['Starter', 'R 299'], ['Business', 'R 549'], ['Premium', 'R 899']]);
    for (const tier of PRICING_TIERS) {
      expect(text).toContain(tier.name);
      expect(text).toContain(tier.price);
      for (const feat of tier.features) expect(text).toContain(feat);
    }
  });
});
