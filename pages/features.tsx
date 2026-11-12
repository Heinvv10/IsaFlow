import Link from 'next/link';
import { Check } from 'lucide-react';
import { PageHead } from '@/components/seo/PageHead';
import { MarketingHeroBand, MarketingPageShell, MarketingSectionHeading } from '@/components/landing/MarketingPageShell';
import { LandingDetailedFeatures } from '@/components/landing/LandingFeatures';
import { LandingCTA } from '@/components/landing/LandingPricingTestimonialsFooter';
import { APP_URL } from '@/components/landing/landingData';
import { BUREAU_FIRM_PORTAL_FREE, BUREAU_SKUS, PAYROLL_ADDON } from '@/components/landing/pricingData';
import { BUREAU_FEATURES, MORE_FEATURES, SARS_FEATURES } from '@/components/landing/featuresPageData';
import { buildMarketingPageJsonLd } from '@/lib/seo/pageSchema';
import { jsonLdScriptText } from '@/lib/seo/faqSchema';

const TITLE = 'IsaFlow Features: Accounting and Payroll for Bureaus and Businesses in South Africa';
const DESCRIPTION = 'What IsaFlow does today: a bureau dashboard across clients, payroll with PAYE, UIF and SDL, VAT201 and EMP201 for eFiling, bank statement import and invoicing.';

/** Public /features page: what is in the product today, bureaus first. */
export default function FeaturesPage() {
  const [ledger, active] = BUREAU_SKUS;
  return (
    <>
      <PageHead path="/features" title={TITLE} description={DESCRIPTION} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScriptText(buildMarketingPageJsonLd({ path: '/features', title: TITLE, description: DESCRIPTION, crumb: 'Features' })) }}
      />
      <MarketingPageShell>
        <MarketingHeroBand eyebrow="Features" title="Books, VAT and payroll for every client, in one place.">
          <p className="text-lg text-white/70">
            IsaFlow is accounting and payroll software for South African practices, bureaus and the
            businesses they look after. This is what is in the product today.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <a href={`${APP_URL}/register`} className="text-slate-900 bg-white rounded-xl px-6 py-3 text-sm font-bold hover:bg-white/90">
              Start free trial
            </a>
            <Link href="/contact" className="text-white border border-white/30 rounded-xl px-6 py-3 text-sm font-semibold hover:bg-white/5">
              Book a demo
            </Link>
          </div>
        </MarketingHeroBand>

        <section id="bureaus" className="py-16 lg:py-24 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl mb-12">
              <MarketingSectionHeading eyebrow="For practices and bureaus" title="Run every client from one desk." />
              <p className="text-lg text-gray-600">
                If you look after the books or payroll of several businesses, IsaFlow keeps each client as its
                own company and gives you one dashboard across all of them.
              </p>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {BUREAU_FEATURES.map(({ icon: Icon, title, body }) => (
                <div key={title} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  {Icon && (
                    <div className="w-11 h-11 rounded-xl bg-gray-900 flex items-center justify-center mb-4">
                      <Icon className="w-5 h-5 text-white" />
                    </div>
                  )}
                  <h3 className="text-lg font-bold text-gray-900 mb-2">{title}</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 rounded-2xl bg-gray-50 p-6 text-gray-700 space-y-2">
              <p>
                {BUREAU_FIRM_PORTAL_FREE && <strong className="text-gray-900">Free for your practice. Pay per active client. </strong>}
                {ledger && active && `${ledger.name} clients are ${ledger.price}${ledger.period} and ${active.name} clients are ${active.price}${active.period}. `}
                Payroll is {PAYROLL_ADDON.price} {PAYROLL_ADDON.unit}.{' '}
                <Link href="/pricing#bureau" className="text-teal-700 underline">See practice pricing</Link>
              </p>
              <p>
                Tell us you are a bureau when you sign up and we set up the bureau dashboard with you.{' '}
                <Link href="/contact" className="text-teal-700 underline">Contact us</Link>
              </p>
            </div>
          </div>
        </section>

        <section id="sars" className="py-16 lg:py-24 bg-gray-50">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <MarketingSectionHeading eyebrow="SARS returns" title="SARS-ready returns, filed by you." />
            <div className="mt-8 grid md:grid-cols-3 gap-6">
              {SARS_FEATURES.map(({ title, body }) => (
                <div key={title} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-bold text-gray-900 mb-2">{title}</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
            <p className="mt-8 text-gray-700">
              IsaFlow prepares the returns. You file them yourself on SARS eFiling or e@syFile Employer.{' '}
              <Link href="/help/preparing-sars-returns-for-efiling" className="text-teal-700 underline">How to prepare SARS returns</Link>
            </p>
          </div>
        </section>

        <div id="business">
          <div className="bg-white pt-16 text-center px-4">
            <MarketingSectionHeading eyebrow="For your business" title="Invoicing, banking and capture in one set of books." />
          </div>
          <LandingDetailedFeatures withScreenshots={false} />
        </div>

        <section id="more" className="py-16 lg:py-24 bg-white">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <MarketingSectionHeading title="Also in the product" />
            <ul className="mt-6 grid sm:grid-cols-2 gap-x-10 gap-y-3">
              {MORE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3">
                  <Check className="w-5 h-5 text-teal-600 mt-0.5 flex-shrink-0" />
                  <span className="text-sm text-gray-700">{f}</span>
                </li>
              ))}
            </ul>
            <p className="mt-8 text-gray-700">
              See what each plan includes on the{' '}
              <Link href="/pricing" className="text-teal-700 underline">pricing page</Link>.
            </p>
          </div>
        </section>

        <LandingCTA />
      </MarketingPageShell>
    </>
  );
}
