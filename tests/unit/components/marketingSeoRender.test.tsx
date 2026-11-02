/**
 * The FAQPage JSON-LD must be the text a visitor can read. Render the real components and compare
 * the emitted schema with the visible FAQ. Also pins the compare route's static paths and 404.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// next/script renders nothing outside a Next app; show its children as a plain script.
vi.mock('next/script', () => ({
  default: ({ children, type }: { children: string; type: string }) => <script type={type}>{children}</script>,
}));

import { LandingJsonLd } from '@/components/seo/LandingJsonLd';
import { LandingFAQ } from '@/components/landing/LandingPricingTestimonialsFooter';
import { ComparePage } from '@/components/landing/ComparePage';
import { COMPARE_ENTRIES } from '@/lib/compare/compareData';
import CompareRoute, { getStaticPaths, getStaticProps } from '../../../pages/compare/[competitor]';

afterEach(cleanup);

interface QA { name: string; acceptedAnswer: { text: string } }
type Graph = { '@graph': Record<string, unknown>[] };

function faqFromDom(container: HTMLElement): QA[] {
  const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')];
  const graphs = blocks.map((b) => JSON.parse(b.textContent ?? '') as Graph);
  const faq = graphs.flatMap((g) => g['@graph']).find((n) => n['@type'] === 'FAQPage');
  return (faq?.mainEntity as QA[] | undefined) ?? [];
}

describe('homepage FAQ schema equals the visible FAQ', () => {
  it('every question and answer in the JSON-LD is on the page, in order', () => {
    const { container } = render(<><LandingJsonLd /><LandingFAQ openFaq={null} onToggle={() => undefined} /></>);
    const schema = faqFromDom(container);
    const visibleQ = [...container.querySelectorAll('button span')].map((e) => e.textContent);
    const visibleA = [...container.querySelectorAll('[role="region"] p')].map((e) => e.textContent);
    expect(schema.length).toBeGreaterThanOrEqual(8);
    expect(schema.map((q) => q.name)).toEqual(visibleQ);
    expect(schema.map((q) => q.acceptedAnswer.text)).toEqual(visibleA);
  });

  it('pairs each question button with its answer region', () => {
    const { container } = render(<LandingFAQ openFaq={null} onToggle={() => undefined} />);
    for (const btn of container.querySelectorAll('button')) {
      const target = container.querySelector(`#${btn.getAttribute('aria-controls')}`);
      expect(target?.getAttribute('aria-labelledby')).toBe(btn.id);
    }
  });
});

describe('compare pages', () => {
  it.each(COMPARE_ENTRIES)('$slug: FAQPage schema equals the visible Q&A', (entry) => {
    const { container } = render(<ComparePage entry={entry} />);
    const schema = faqFromDom(container);
    const visibleQ = [...container.querySelectorAll('#faq dt')].map((e) => e.textContent);
    const visibleA = [...container.querySelectorAll('#faq dd')].map((e) => e.textContent);
    expect(schema.length).toBe(entry.faq.length);
    expect(schema.map((q) => q.name)).toEqual(visibleQ);
    expect(schema.map((q) => q.acceptedAnswer.text)).toEqual(visibleA);
  });

  it('declares no dangling @id references', () => {
    const { container } = render(<ComparePage entry={COMPARE_ENTRIES[0]!} />);
    const root = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.textContent ?? '') as unknown;
    const defined = new Set<string>();
    const refs: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        const id = o['@id'];
        if (typeof id === 'string') {
          if (Object.keys(o).length === 1) refs.push(id);
          else defined.add(id);
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(root);
    expect(refs.length + defined.size).toBeGreaterThan(0);
    for (const r of refs) expect(defined.has(r), r).toBe(true);
  });

  it('uses no text-ink-muted (1.4:1 on the white page)', () => {
    const { container } = render(<ComparePage entry={COMPARE_ENTRIES[0]!} />);
    expect(container.innerHTML).not.toContain('text-ink-muted');
  });
});

describe('/compare/[competitor] route', () => {
  it('prebuilds exactly the known slugs and 404s the rest', async () => {
    const paths = await (getStaticPaths as unknown as () => Promise<{ paths: { params: { competitor: string } }[]; fallback: unknown }>)();
    expect(paths.fallback).toBe(false);
    expect(paths.paths.map((p) => p.params.competitor)).toEqual(['sage', 'xero', 'quickbooks']);
    const gsp = getStaticProps as unknown as (c: { params?: Record<string, string> }) => Promise<Record<string, unknown>>;
    expect(await gsp({ params: { competitor: 'zoho' } })).toEqual({ notFound: true });
    expect(await gsp({ params: {} })).toEqual({ notFound: true });
    expect(await gsp({ params: { competitor: 'sage' } })).toHaveProperty('props.entry.slug', 'sage');
  });

  it('renders the page for a known entry', () => {
    const { container } = render(<CompareRoute entry={COMPARE_ENTRIES[1]!} />);
    expect(container.querySelector('h1')?.textContent).toContain('Xero');
  });
});
