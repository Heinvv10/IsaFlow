/**
 * Marketing surfaces must not depend on the app theme. With `accounting-theme=light` the
 * `dark` class is absent, and `text-slate-900 dark:text-white` on an always-dark surface
 * made pricing buttons, pillar icons, the closing CTA and the footer logo vanish.
 * happy-dom does not apply Tailwind, so class assertions are a proxy; the screenshots
 * in the PR are the visual proof.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LandingFeaturesGrid } from '@/components/landing/LandingFeatures';
import { LandingPricing, LandingCTA, LandingFooter, LandingFAQ } from '@/components/landing/LandingPricingTestimonialsFooter';

const ROOT = join(__dirname, '../../..');
const DARK_VARIANT = /(^|[\s"'`])dark:/;

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

function withTheme(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
}

describe.each([['light', false], ['dark', true]] as const)('marketing sections in the %s theme', (_name, dark) => {
  it('render no dark: variants', () => {
    withTheme(dark);
    const { container } = render(
      <>
        <LandingFeaturesGrid />
        <LandingPricing />
        <LandingFAQ openFaq={null} onToggle={() => undefined} />
        <LandingCTA />
        <LandingFooter />
      </>,
    );
    expect(container.innerHTML).not.toMatch(DARK_VARIANT);
  });

  it('pricing tier buttons are white text and keep their labels', () => {
    withTheme(dark);
    const { container } = render(<LandingPricing />);
    const text = container.textContent ?? '';
    for (const name of ['Starter', 'Business', 'Premium']) expect(text).toContain(name);
    const ctas = [...container.querySelectorAll('a')].filter((a) => a.textContent?.trim() === 'Start Free Trial');
    expect(ctas).toHaveLength(3);
    for (const a of ctas) {
      expect(a.className).toMatch(/(^|\s)text-white(\s|$)/);
      expect(a.className).not.toContain('text-slate-900');
    }
  });

  it('pillar icon tiles are dark with a white icon', () => {
    withTheme(dark);
    const { container } = render(<LandingFeaturesGrid />);
    const tiles = [...container.querySelectorAll('div.w-14.h-14')];
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) {
      expect(tile.className).toMatch(/(^|\s)bg-gray-900(\s|$)/);
      expect(tile.querySelector('svg')?.getAttribute('class')).toMatch(/(^|\s)text-white(\s|$)/);
    }
  });

  it('footer is a dark surface with the logo', () => {
    withTheme(dark);
    const { container } = render(<LandingFooter />);
    const footer = container.querySelector('footer')!;
    expect(footer.className).toContain('bg-gray-900');
    expect(footer.className).not.toMatch(/(^|\s)bg-white(\s|$)/);
    expect(footer.querySelector('img[alt="IsaFlow"]')).not.toBeNull();
    for (const p of footer.querySelectorAll('p.font-semibold')) expect(p.className).toMatch(/(^|\s)text-white(\s|$)/);
  });

  it('closing CTA is a dark surface with a white Book a Demo link', () => {
    withTheme(dark);
    const { container } = render(<LandingCTA />);
    expect(container.querySelector('section')!.className).toContain('bg-gray-900');
    const demo = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('Book a Demo'))!;
    expect(demo.getAttribute('href')).toBe('/contact');
    expect(demo.className).toMatch(/(^|\s)text-white(\s|$)/);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('dark: census on marketing sources', () => {
  // Rewritten by feat/website-river-hero-20261112; add it here once that lands.
  const EXCLUDED = new Set(['src/components/landing/LandingHero.tsx']);
  const files = [
    ...walk(join(ROOT, 'src/components/landing')).map((p) => relative(ROOT, p)),
    'pages/pricing.tsx', 'pages/contact.tsx', 'pages/features.tsx', 'pages/about.tsx', 'pages/compare/[competitor].tsx',
  ].filter((f) => !EXCLUDED.has(f));

  it.each(files)('%s has no dark: class variant', (file) => {
    expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(DARK_VARIANT);
  });
});
