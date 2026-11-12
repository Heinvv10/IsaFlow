import { useState, useEffect } from 'react';
import { PageHead } from '@/components/seo/PageHead';
import { LandingJsonLd } from '@/components/seo/LandingJsonLd';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingHero } from '@/components/landing/LandingHero';
import { LandingFeaturesGrid, LandingDetailedFeatures } from '@/components/landing/LandingFeatures';
import { LandingSouthAfricaBand } from '@/components/landing/LandingSouthAfricaBand';
import {
  LandingPricing,
  LandingFAQ,
  LandingCTA,
  LandingFooter,
} from '@/components/landing/LandingPricingTestimonialsFooter';

export default function LandingPage() {
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
        path="/"
        title="IsaFlow: Cloud Accounting Software for South African Businesses"
        description="Cloud accounting for South Africa: invoicing, bank statement import and reconciliation, VAT201 preparation, and payroll with PAYE, UIF and SDL. Try it free for 30 days."
      />

      <LandingJsonLd />

      <div className="min-h-screen bg-white text-gray-900">
        <LandingNavbar
          scrolled={scrolled}
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />
        <LandingHero />
        <LandingFeaturesGrid />
        <LandingDetailedFeatures />
        <LandingSouthAfricaBand />
        <LandingPricing />
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
