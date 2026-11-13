import { BRAND } from '@/components/landing/landingData';

interface MarketingPageSchema {
  path: string;
  title: string;
  description: string;
  /** Breadcrumb label for the page. */
  crumb: string;
  type?: 'WebPage' | 'AboutPage';
}

/** WebPage (or AboutPage) plus BreadcrumbList JSON-LD for a public marketing page. */
export function buildMarketingPageJsonLd(p: MarketingPageSchema): Record<string, unknown> {
  const url = `${BRAND.url}${p.path}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': p.type ?? 'WebPage',
        '@id': `${url}#page`,
        url,
        name: p.title,
        description: p.description,
        inLanguage: 'en-ZA',
        isPartOf: { '@type': 'WebSite', '@id': `${BRAND.url}#website`, name: BRAND.name, url: BRAND.url },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'IsaFlow', item: `${BRAND.url}/` },
          { '@type': 'ListItem', position: 2, name: p.crumb, item: url },
        ],
      },
    ],
  };
}
