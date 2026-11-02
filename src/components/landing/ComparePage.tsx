import { useState, useEffect } from 'react';
import Link from 'next/link';
import { LandingNavbar } from './LandingNavbar';
import { LandingFooter } from './LandingPricingTestimonialsFooter';
import { APP_URL, BRAND, PRICING_TIERS } from './landingData';
import { PageHead } from '@/components/seo/PageHead';
import { COMPARE_ENTRIES, type CompareEntry } from '@/lib/compare/compareData';
import { buildFaqPage, jsonLdScriptText } from '@/lib/seo/faqSchema';

function buildJsonLd(entry: CompareEntry): Record<string, unknown> {
  const url = `${BRAND.url}/compare/${entry.slug}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${url}#page`,
        url,
        name: entry.title,
        description: entry.description,
        inLanguage: 'en-ZA',
        isPartOf: { '@type': 'WebSite', '@id': `${BRAND.url}#website`, name: BRAND.name, url: BRAND.url },
        about: {
          '@type': 'SoftwareApplication',
          name: BRAND.name,
          url: BRAND.url,
          applicationCategory: BRAND.applicationCategory,
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'ISAFlow', item: `${BRAND.url}/` },
          { '@type': 'ListItem', position: 2, name: `ISAFlow vs ${entry.name}`, item: url },
        ],
      },
      buildFaqPage(`${url}#faq`, entry.faq),
    ],
  };
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 space-y-2 text-gray-700">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

export function ComparePage({ entry }: { entry: CompareEntry }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const others = COMPARE_ENTRIES.filter((e) => e.slug !== entry.slug);
  const starterPrice = PRICING_TIERS[0]?.price;

  return (
    <>
      <PageHead path={`/compare/${entry.slug}`} title={entry.title} description={entry.description} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScriptText(buildJsonLd(entry)) }}
      />
      <div className="min-h-screen bg-white text-gray-900">
        <LandingNavbar
          scrolled={scrolled}
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />

        <section className="bg-[#050a0f] text-white pt-32 pb-14 lg:pt-40 lg:pb-16">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <p className="text-sm font-semibold text-teal-400 tracking-widest uppercase mb-4">Compare</p>
            <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4">
              ISAFlow vs {entry.product}
            </h1>
            <p className="text-lg text-white/70">{entry.intro}</p>
          </div>
        </section>

        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14 space-y-12 text-base leading-relaxed">
          <section>
            <h2 className="text-2xl font-bold mb-4">At a glance</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="hidden sm:table-header-group">
                  <tr className="border-b border-gray-200 text-left">
                    <th className="py-3 pr-4 font-semibold">Topic</th>
                    <th className="py-3 px-4 font-semibold text-teal-700">ISAFlow</th>
                    <th className="py-3 pl-4 font-semibold">{entry.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.rows.map((row) => (
                    <tr key={row.topic} className="block sm:table-row border-b border-gray-100 py-3 sm:py-0 align-top">
                      <th scope="row" className="block sm:table-cell sm:py-3 sm:pr-4 text-left font-semibold sm:font-medium">{row.topic}</th>
                      <td className="block sm:table-cell sm:py-3 sm:px-4 pt-1 text-gray-700">
                        <span className="sm:hidden font-semibold text-teal-700">ISAFlow: </span>{row.isaflow}
                      </td>
                      <td className="block sm:table-cell sm:py-3 sm:pl-4 pt-1 text-gray-700">
                        <span className="sm:hidden font-semibold">{entry.name}: </span>{row.other}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm text-gray-700">
              We describe {entry.name} in general terms. Plans and features change, so check the
              vendor&apos;s own site for current details.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4">Where {entry.name} may suit you better</h2>
            <List items={entry.otherStrengths} />
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4">Where ISAFlow may suit you better</h2>
            <List items={entry.isaflowStrengths} />
            <p className="mt-4 text-gray-700">
              {starterPrice ? `ISAFlow plans start at ${starterPrice} a month, VAT included. ` : ''}See the{' '}
              <Link href="/pricing" className="text-teal-700 underline">pricing page</Link> for every plan.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4">Switching from {entry.name}</h2>
            <p className="text-gray-700">{entry.switching}</p>
          </section>

          <section id="faq">
            <h2 className="text-2xl font-bold mb-4">Questions and answers</h2>
            <dl className="space-y-6">
              {entry.faq.map((item) => (
                <div key={item.q}>
                  <dt className="font-semibold">{item.q}</dt>
                  <dd className="mt-1 text-gray-700">{item.a}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded-2xl bg-gray-50 p-6">
            <h2 className="text-xl font-bold mb-2">Try ISAFlow free for {BRAND.freeTrialDays} days</h2>
            <p className="text-gray-700 mb-4">No credit card needed.</p>
            <a
              href={`${APP_URL}/register`}
              className="inline-block px-5 py-2.5 text-sm font-semibold text-white bg-brand-600 rounded-xl hover:bg-brand-700"
            >
              Start free trial
            </a>
            <p className="mt-4 text-sm text-gray-700">
              Also compare:{' '}
              {others.map((o, i) => (
                <span key={o.slug}>
                  {i > 0 && ', '}
                  <Link href={`/compare/${o.slug}`} className="text-teal-700 underline">ISAFlow vs {o.name}</Link>
                </span>
              ))}
            </p>
          </section>
        </main>

        <LandingFooter />
      </div>
    </>
  );
}
