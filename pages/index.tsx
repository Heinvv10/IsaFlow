import { useState, useEffect } from 'react';
import Head from 'next/head';
import { LandingJsonLd } from '@/components/seo/LandingJsonLd';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingHero } from '@/components/landing/LandingHero';
import { LandingFeaturesGrid, LandingDetailedFeatures } from '@/components/landing/LandingFeatures';
import {
  LandingTrustBar,
  LandingPricing,
  LandingTestimonials,
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
      <Head>
        <title>ISAFlow — Accounting Software for Modern Business</title>
        <meta
          name="description"
          content="Invoicing, bank reconciliation, tax compliance and payroll — everything your business needs in one powerful platform."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <LandingJsonLd />

      <div className="min-h-screen bg-white text-gray-900">
        <LandingNavbar
          scrolled={scrolled}
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />
        <LandingHero />
        <LandingTrustBar />
        <LandingFeaturesGrid />
        <LandingDetailedFeatures />
        <LandingTestimonials />
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
