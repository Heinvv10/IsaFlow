/**
 * Shared shell for the public legal pages (/privacy, /terms).
 * Uses the landing navbar and footer so the pages match the marketing site.
 */
import { useEffect, useState, type ReactNode } from 'react';
import Head from 'next/head';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingFooter } from '@/components/landing/LandingPricingTestimonialsFooter';
import { LEGAL_ENTITY, LEGAL_LAST_UPDATED } from '@/config/legalEntity';

interface Props {
  title: string;
  description: string;
  children: ReactNode;
}

export function LegalPage({ title, description, children }: Props) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <>
      <Head>
        <title>{`${title} | IsaFlow`}</title>
        <meta name="description" content={description} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="min-h-screen bg-white text-gray-900">
        <LandingNavbar
          scrolled={scrolled}
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />

        <section className="bg-[#050a0f] text-white pt-32 pb-12 lg:pt-40">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <p className="text-sm font-semibold text-teal-400 tracking-widest uppercase mb-4">Legal</p>
            <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4">{title}</h1>
            <p className="text-white/70">Last updated: {LEGAL_LAST_UPDATED}</p>
          </div>
        </section>

        <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 legal-content space-y-4 text-gray-700 leading-relaxed [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-gray-900 [&_h2]:pt-6 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1 [&_a]:text-teal-600 [&_a]:underline">
          {children}
        </main>

        <section className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 text-sm text-gray-500">
          IsaFlow is a trading name of {LEGAL_ENTITY.name}, registration number{' '}
          {LEGAL_ENTITY.registrationNumber}.
        </section>

        <LandingFooter />
      </div>
    </>
  );
}
