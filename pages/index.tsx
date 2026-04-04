import { useState, useEffect } from 'react';
import Head from 'next/head';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingHero } from '@/components/landing/LandingHero';
import { LandingFeaturesGrid, LandingDetailedFeatures } from '@/components/landing/LandingFeatures';
import {
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
        <title>ISAFlow — Modern Accounting for South African Businesses</title>
        <meta name="description" content="Cloud accounting software built for SA. VAT, SARS compliance, bank reconciliation, invoicing, payroll — all in one platform." />
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
        <LandingHero />
        <LandingFeaturesGrid />
        <LandingDetailedFeatures />
        <LandingPricing />
        <LandingTestimonials />
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
