/**
 * /features, /about and the SimplePay and PaySpace compare pages: they render, carry their
 * head and JSON-LD, are linked from the footer and nav, and hold to the copy rules.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// next/head renders nothing in tests: expose PageHead's props instead.
vi.mock('@/components/seo/PageHead', () => ({
  PageHead: ({ path, title, description }: { path: string; title: string; description: string }) => (
    <div data-testid="page-head" data-path={path} data-title={title} data-description={description} />
  ),
}));

import FeaturesPage from '../../../pages/features';
import AboutPage from '../../../pages/about';
import { ComparePage } from '@/components/landing/ComparePage';
import { LandingFooter } from '@/components/landing/LandingPricingTestimonialsFooter';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingDetailedFeatures } from '@/components/landing/LandingFeatures';
import { COMPARE_ENTRIES, getCompareEntry } from '@/lib/compare/compareData';
import { BUREAU_SKUS, PAYROLL_ADDON } from '@/components/landing/pricingData';
import { APP_URL, DETAILED_FEATURES } from '@/components/landing/landingData';
import { LEGAL_ENTITY } from '@/config/legalEntity';

afterEach(cleanup);

const ROOT = join(__dirname, '../../..');
const FORBIDDEN: RegExp[] = [/\u2014/, /ISAFlow|Isaflow|ISA Flow/, /bank feeds?/i, /ABSA/i, /submit(s|ted|ting)? to SARS/i, /extension/i];
const DARK_VARIANT = /(^|[\s"'`])dark:/;

type Graph = { '@graph': Record<string, unknown>[] };

const PAGES: { name: string; path: string; h1: string; el: () => JSX.Element }[] = [
  { name: 'features', path: '/features', h1: 'Books, VAT and payroll for every client, in one place.', el: () => <FeaturesPage /> },
  { name: 'about', path: '/about', h1: 'South African accounting and payroll, for bureaus and the businesses they serve.', el: () => <AboutPage /> },
  { name: 'compare simplepay', path: '/compare/simplepay', h1: 'IsaFlow vs SimplePay', el: () => <ComparePage entry={getCompareEntry('simplepay')!} /> },
  { name: 'compare payspace', path: '/compare/payspace', h1: 'IsaFlow vs PaySpace', el: () => <ComparePage entry={getCompareEntry('payspace')!} /> },
];

describe.each(PAGES)('$name page', ({ path, h1, el }) => {
  it('renders one h1, its head and its JSON-LD', () => {
    const { container } = render(el());
    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(h1);
    const head = container.querySelector('[data-testid="page-head"]')!;
    expect(head.getAttribute('data-path')).toBe(path);
    expect(head.getAttribute('data-title')).toContain('IsaFlow');
    const desc = head.getAttribute('data-description') ?? '';
    expect(desc.length).toBeGreaterThanOrEqual(110);
    expect(desc.length).toBeLessThanOrEqual(170);
    const graphs = [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent ?? '') as Graph);
    const pageNode = graphs.flatMap((g) => g['@graph']).find((n) => String(n['@id']).endsWith('#page'));
    expect(pageNode?.url).toBe(`https://isaflow.co.za${path}`);
  });

  it('holds to the copy rules', () => {
    const { container } = render(el());
    const head = container.querySelector('[data-testid="page-head"]');
    const text = `${container.textContent ?? ''} ${head?.getAttribute('data-title')} ${head?.getAttribute('data-description')}`;
    for (const re of FORBIDDEN) expect(text, String(re)).not.toMatch(re);
    expect(container.innerHTML).not.toMatch(DARK_VARIANT);
  });
});

describe('/features', () => {
  it('puts bureaus before businesses', () => {
    const { container } = render(<FeaturesPage />);
    const bureaus = container.querySelector('#bureaus')!;
    const business = container.querySelector('#business')!;
    expect(bureaus.compareDocumentPosition(business) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('describes bureau setup as the code does it: Accountant sign-up, dashboard switched on, clients linked by the bureau', () => {
    const text = render(<FeaturesPage />).container.querySelector('#bureaus')?.textContent ?? '';
    expect(text).toContain('Choose Accountant when you sign up');
    expect(text).toContain('link your client companies yourself');
    expect(text).not.toMatch(/sets itself up|set up the bureau dashboard with you/);
    expect(text).toContain('EMP201');
  });

  it('shows no product screenshots (they carry the old logo and demo counterparties)', () => {
    const { container } = render(<FeaturesPage />);
    expect(container.querySelector('#business img')).toBeNull();
    expect(container.querySelector('#business')?.textContent).toContain(DETAILED_FEATURES[0]!.title);
  });

  it('takes its prices from pricingData and links onwards', () => {
    const { container } = render(<FeaturesPage />);
    const text = container.textContent ?? '';
    for (const p of [BUREAU_SKUS[0]!.price, BUREAU_SKUS[1]!.price, PAYROLL_ADDON.price]) expect(text).toContain(p);
    for (const href of ['/pricing', '/contact', `${APP_URL}/register`]) {
      expect(container.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    }
  });
});

describe('/about', () => {
  it('names the operator and principles, and no people or street address', () => {
    const { container } = render(<AboutPage />);
    const text = container.textContent ?? '';
    for (const s of [LEGAL_ENTITY.name, 'trading as IsaFlow', 'Pretoria', 'POPIA', 'e@syFile Employer']) expect(text).toContain(s);
    for (const s of [LEGAL_ENTITY.director, LEGAL_ENTITY.informationOfficer, LEGAL_ENTITY.registeredAddress]) expect(text).not.toContain(s);
  });

  it('does not show the company registration number', () => {
    const { container } = render(<AboutPage />);
    const text = container.textContent ?? '';
    expect(text).not.toContain(LEGAL_ENTITY.registrationNumber);
    expect(text.toLowerCase()).not.toContain('registration number');
  });
});

describe('navigation', () => {
  it('footer links features, about and every compare page', () => {
    const { container } = render(<LandingFooter />);
    expect(container.querySelector('a[href="/features"]')).not.toBeNull();
    expect(container.querySelector('a[href="/about"]')).not.toBeNull();
    expect(container.querySelector('a[href="/#features"]')).toBeNull();
    for (const e of COMPARE_ENTRIES) expect(container.querySelector(`a[href="/compare/${e.slug}"]`), e.slug).not.toBeNull();
  });

  it('navbar Features goes to /features', () => {
    const { container } = render(<LandingNavbar scrolled={false} mobileMenuOpen={false} onToggleMobile={() => undefined} onCloseMobile={() => undefined} />);
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Features');
    expect(link?.getAttribute('href')).toBe('/features');
  });
});

describe('feature screenshots', () => {
  it('are lazy, sized, responsive webp images', () => {
    const { container } = render(<LandingDetailedFeatures />);
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs).toHaveLength(DETAILED_FEATURES.length);
    for (const img of imgs) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('width')).toBeTruthy();
      expect(img.getAttribute('height')).toBeTruthy();
      expect(img.getAttribute('src')).toMatch(/\.webp$/);
      expect(img.getAttribute('srcset')).toMatch(/640w.*1200w/);
    }
  });
});

describe('source files of new and changed copy', () => {
  it.each([
    'src/components/landing/featuresPageData.ts', 'pages/features.tsx', 'pages/about.tsx', 'src/lib/compare/compareData.ts',
    'src/components/landing/WaitlistPageShell.tsx', 'src/components/landing/MarketingPageShell.tsx', 'src/lib/seo/pageSchema.ts',
  ])('%s has no em dash', (file) => {
    expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(/\u2014/);
  });
});
