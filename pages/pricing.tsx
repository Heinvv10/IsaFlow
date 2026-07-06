import { useState, useEffect } from 'react';
import Head from 'next/head';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import {
  LandingPricing,
  LandingFAQ,
  LandingCTA,
  LandingFooter,
} from '@/components/landing/LandingPricingTestimonialsFooter';
import {
  PricingHero,
  SageComparison,
  CloseAgentAddOn,
  BureauSection,
  PriceLockBand,
} from '@/components/landing/PricingPageSections';

/**
 * Public /pricing page — Phase 6 commercial wedge.
 * Numbers are Hein-signed Scenario C (docs/commercial/pricing-skus.md); the
 * marketing prose is a draft pending Hein's copy review before public launch.
 */
export default function PricingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <>
      <Head>
        <title>Pricing — ISAFlow | Cloud accounting for South African business</title>
        <meta
          name="description"
          content="Simple, honest pricing for books, VAT and payroll — everything Sage charges extra for, included. Your rate is capped at inflation, guaranteed. 30-day free trial."
        />
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
        <PricingHero />
        <LandingPricing />
        <SageComparison />
        <CloseAgentAddOn />
        <BureauSection />
        <PriceLockBand />
        <LandingFAQ
          openFaq={openFaq}
          onToggle={(i) => setOpenFaq(openFaq === i ? null : i)}
        />
        <LandingCTA />
        <LandingFooter />
      </div>
    </>
  );
}
