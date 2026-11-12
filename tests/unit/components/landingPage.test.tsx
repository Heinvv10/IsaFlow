/**
 * isaflow.co.za's landing page: no stats figures and no DB props (so no figure can reach
 * __NEXT_DATA__), the River hero first, the South Africa band directly before pricing, no
 * unverified testimonials or "trusted by" strip, and pricing unchanged.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LandingPage from '../../../pages/index';
import * as page from '../../../pages/index';
import { PRICING_TIERS } from '@/components/landing/landingData';
import { installIntersectionObserver, setRiverEnv } from './landingRiverMocks';

beforeEach(() => {
  setRiverEnv({ desktop: false, reducedMotion: false, saveData: false });
  installIntersectionObserver();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('landing page data', () => {
  it('ships no server props', () => {
    expect('getStaticProps' in page).toBe(false);
    expect('getServerSideProps' in page).toBe(false);
  });
});

describe('landing page content', () => {
  it('renders no stats figure', () => {
    const { container } = render(<LandingPage />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Transactions Processed');
    expect(text).not.toContain('Invoices Processed');
    expect(text).not.toMatch(/\d+\+ ?Businesses/);
    expect(text).not.toMatch(/R \d[\d.,]*[MKB]\+/);
  });

  it('puts the hero first and the South Africa band directly before pricing', () => {
    const { container } = render(<LandingPage />);
    expect(container.querySelector('#hero h1')?.textContent).toBe('Keep the books flowing.');
    const band = container.querySelector('#south-africa');
    const pricing = container.querySelector('#pricing');
    expect(band).not.toBeNull();
    expect(pricing).not.toBeNull();
    expect(band?.nextElementSibling).toBe(pricing);
  });

  it('has no testimonials or trust strip', () => {
    const { container } = render(<LandingPage />);
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
    const { container } = render(<LandingPage />);
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
