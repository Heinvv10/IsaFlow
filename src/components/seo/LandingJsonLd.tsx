import Script from 'next/script';
import { BRAND, BRAND_SAME_AS, FAQ_ITEMS } from '@/components/landing/landingData';
import { buildFaqPage, jsonLdScriptText } from '@/lib/seo/faqSchema';

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
      address: {
        '@type': 'PostalAddress',
        addressLocality: BRAND.addressLocality,
        addressRegion: BRAND.addressRegion,
        addressCountry: BRAND.countryCode,
      },
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
        description: `${BRAND.freeTrialLabel}, no credit card required.`,
      },
      featureList: [
        'Invoicing & quotes',
        'Bank reconciliation',
        'VAT201 prepared for filing on SARS eFiling',
        'Payroll: PAYE, UIF, SDL, EMP201 and IRP5 preparation',
        'Fixed assets and budgets',
        'Financial reports',
        'Annual financial statements (Premium plan)',
        'AI document capture (Business plan and above)',
        'Bank statement imports (CSV, PDF, OFX, QIF)',
        'Migration from Sage, Xero, QuickBooks, Pastel',
        'Two-factor authentication (TOTP)',
        'Field-level audit trail',
      ],
    },
    buildFaqPage(`${BRAND.url}#faq`, FAQ_ITEMS),
  ];

  return {
    '@context': 'https://schema.org',
    '@graph': nodes,
  };
}

export function LandingJsonLd() {
  return (
    <Script id="isaflow-landing-jsonld" type="application/ld+json" strategy="beforeInteractive">
      {jsonLdScriptText(buildGraph())}
    </Script>
  );
}
