import Link from 'next/link';
import { PageHead } from '@/components/seo/PageHead';
import { MarketingHeroBand, MarketingPageShell } from '@/components/landing/MarketingPageShell';
import { APP_URL, BRAND } from '@/components/landing/landingData';
import { LEGAL_ENTITY } from '@/config/legalEntity';
import { buildMarketingPageJsonLd } from '@/lib/seo/pageSchema';
import { jsonLdScriptText } from '@/lib/seo/faqSchema';

const TITLE = 'About IsaFlow: South African Accounting and Payroll Software from Pretoria';
const DESCRIPTION = `IsaFlow is accounting and payroll software for South African bureaus, practices and businesses, operated by ${LEGAL_ENTITY.name} from Pretoria.`;

const AUDIENCES = [
  { title: 'Accounting practices and bureaus', body: 'Run the books and payroll for many clients. Each client is its own company, and one dashboard shows the work owed across all of them.' },
  { title: 'Small and medium businesses', body: 'Keep invoicing, banking, VAT and payroll in one set of books, on your own or with your accountant.' },
];

/** Public /about page. No people, dates or customer numbers: only facts held in this repo. */
export default function AboutPage() {
  return (
    <>
      <PageHead path="/about" title={TITLE} description={DESCRIPTION} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScriptText(buildMarketingPageJsonLd({ path: '/about', title: TITLE, description: DESCRIPTION, crumb: 'About', type: 'AboutPage' })) }}
      />
      <MarketingPageShell>
        <MarketingHeroBand eyebrow="About" title="South African accounting and payroll, for bureaus and the businesses they serve.">
          <p className="text-lg text-white/70">
            IsaFlow keeps the books, VAT and payroll of South African businesses in one system, and gives the
            practices that look after them one place to work.
          </p>
        </MarketingHeroBand>

        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-14 space-y-12 text-base leading-relaxed">
          <section>
            <h2 className="text-2xl font-bold mb-4">Who we are</h2>
            <p className="text-gray-700">
              IsaFlow is operated by {LEGAL_ENTITY.name},
              trading as IsaFlow. Our head office is in Pretoria, South Africa.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4">What we make</h2>
            <p className="text-gray-700">
              IsaFlow is cloud accounting and payroll software. It covers invoicing and quotes, bank statement import
              and reconciliation, VAT201 preparation, payroll, fixed assets, budgets and financial reports. It runs in
              your browser and is built around South African VAT, payroll tax and reporting rules.
            </p>
            <p className="mt-4">
              <Link href="/features" className="text-teal-700 underline">See all features</Link>
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4">Who it is for</h2>
            <div className="grid sm:grid-cols-2 gap-6">
              {AUDIENCES.map((a) => (
                <div key={a.title} className="rounded-2xl border border-gray-200 p-6">
                  <h3 className="font-bold text-gray-900 mb-2">{a.title}</h3>
                  <p className="text-sm text-gray-700">{a.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4">How we build it</h2>
            <dl className="space-y-6">
              <div>
                <dt className="font-semibold">SARS-ready returns, filed by you</dt>
                <dd className="mt-1 text-gray-700">
                  IsaFlow prepares VAT201 and EMP201 for you to file on eFiling, and EMP501 and IRP5/IT3(a) for you to
                  submit through e@syFile Employer. Filing stays with you.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Your bank statement is the source</dt>
                <dd className="mt-1 text-gray-700">
                  You import the statements your bank gives you, in CSV, OFX, QFX, QIF, MT940 or PDF. IsaFlow matches
                  the transactions with rules, references, amounts, dates and AI suggestions.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">POPIA and South African hosting</dt>
                <dd className="mt-1 text-gray-700">
                  Our application and database servers are hosted in South Africa. We handle personal information under
                  the Protection of Personal Information Act (POPIA), as set out in our{' '}
                  <Link href="/privacy" className="text-teal-700 underline">privacy policy</Link>.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">A record of every change</dt>
                <dd className="mt-1 text-gray-700">
                  Financial records carry a field-level audit trail, with two-factor authentication and permissions by module.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Rand pricing you can try first</dt>
                <dd className="mt-1 text-gray-700">
                  Plans are priced in rand with VAT included, and every plan starts with a {BRAND.freeTrialLabel}. No
                  credit card is required.{' '}
                  <Link href="/pricing" className="text-teal-700 underline">See pricing</Link>
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-2xl bg-gray-50 p-6">
            <h2 className="text-xl font-bold mb-2">Talk to us</h2>
            <p className="text-gray-700 mb-4">
              Email{' '}
              <a href={`mailto:${LEGAL_ENTITY.contactEmail}`} className="text-teal-700 underline">{LEGAL_ENTITY.contactEmail}</a>{' '}
              or book a demo.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/contact" className="text-white bg-brand-600 hover:bg-brand-700 rounded-xl px-5 py-2.5 text-sm font-semibold">
                Book a demo
              </Link>
              <a href={`${APP_URL}/register`} className="border border-gray-300 text-gray-900 rounded-xl px-5 py-2.5 text-sm font-semibold">
                Start free trial
              </a>
            </div>
          </section>
        </main>
      </MarketingPageShell>
    </>
  );
}
