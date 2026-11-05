import { useState, useEffect } from 'react';
import { PageHead } from '@/components/seo/PageHead';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import {
  LandingPricing,
  LandingFAQ,
  LandingCTA,
  LandingFooter,
} from '@/components/landing/LandingPricingTestimonialsFooter';
import {
  PricingHero,
  PayAsYouGoSection,
  SageComparison,
  CloseAgentAddOn,
  BureauSection,
  PriceLockBand,
} from '@/components/landing/PricingPageSections';

/**
 * Public /pricing page: Phase 6 commercial wedge.
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
      <PageHead
        path="/pricing"
        title="IsaFlow Pricing: Accounting, VAT and Payroll Plans for South Africa"
        description="Simple monthly pricing in rand for South African businesses. Books, VAT201 and bank reconciliation in every plan, payroll as an add-on. 30-day free trial."
      />

      <div className="min-h-screen bg-white text-gray-900">
        <LandingNavbar
          scrolled={scrolled}
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />
        <PricingHero />
        <LandingPricing />
        <PayAsYouGoSection />
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
