import Script from 'next/script';
import { BRAND, BRAND_SAME_AS, FAQ_ITEMS } from '@/components/landing/landingData';

const ORG_ID = `${BRAND.url}#organization`;
const APP_ID = `${BRAND.url}#software`;

function buildGraph() {
  const nodes: Record<string, unknown>[] = [
    {
      '@type': 'Organization',
      '@id': ORG_ID,
      name: BRAND.name,
      legalName: BRAND.legalName,
      url: BRAND.url,
      logo: BRAND.logo,
      description: BRAND.description,
      areaServed: {
        '@type': 'Country',
        name: 'South Africa',
      },
      ...(BRAND_SAME_AS.length > 0 ? { sameAs: BRAND_SAME_AS } : {}),
    },
    {
      '@type': ['SoftwareApplication', 'WebApplication'],
      '@id': APP_ID,
      name: BRAND.name,
      url: BRAND.url,
      applicationCategory: BRAND.applicationCategory,
      applicationSubCategory: 'AccountingSoftware',
      operatingSystem: BRAND.operatingSystem,
      description: BRAND.description,
      publisher: { '@id': ORG_ID },
      offers: {
        '@type': 'Offer',
        category: 'Free trial',
        description: `${BRAND.freeTrialDays}-day free trial — no credit card required.`,
      },
      featureList: [
        'Invoicing & quotes',
        'Bank reconciliation',
        'VAT & tax compliance',
        'Payroll',
        'Bank statement imports (CSV, PDF, OFX, QIF)',
        'Migration from Sage, Xero, QuickBooks, Pastel',
        'Two-factor authentication (TOTP)',
        'Field-level audit trail',
      ],
    },
    {
      '@type': 'FAQPage',
      '@id': `${BRAND.url}#faq`,
      mainEntity: FAQ_ITEMS.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.a,
        },
      })),
    },
  ];

  return {
    '@context': 'https://schema.org',
    '@graph': nodes,
  };
}

export function LandingJsonLd() {
  return (
    <Script id="isaflow-landing-jsonld" type="application/ld+json" strategy="beforeInteractive">
      {JSON.stringify(buildGraph())}
    </Script>
  );
}
