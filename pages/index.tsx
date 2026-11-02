import { useState, useEffect } from 'react';
import type { GetStaticProps } from 'next';
import { PageHead } from '@/components/seo/PageHead';
import { LandingJsonLd } from '@/components/seo/LandingJsonLd';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingHero } from '@/components/landing/LandingHero';
import { LandingFeaturesGrid, LandingDetailedFeatures } from '@/components/landing/LandingFeatures';
import { getLandingStats, type LandingStats } from '@/lib/landing/landingStats';
import {
  LandingPricing,
  LandingFAQ,
  LandingCTA,
  LandingFooter,
} from '@/components/landing/LandingPricingTestimonialsFooter';

interface Props {
  stats: LandingStats | null;
}

// ISR: the live aggregates are rendered into the HTML, refreshed hourly. A DB
// failure (e.g. none reachable at build time) yields null stats and a short
// revalidate, so the page still builds and the next request retries soon.
export const getStaticProps: GetStaticProps<Props> = async () => {
  const stats = await getLandingStats();
  return { props: { stats }, revalidate: stats ? 3600 : 60 };
};

export default function LandingPage({ stats }: Props) {
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
        title="ISAFlow: Cloud Accounting Software for South African Businesses"
        description="Cloud accounting for South Africa: invoicing, bank reconciliation, VAT201 and SARS compliance, and payroll with PAYE, UIF and SDL. Try it free for 30 days."
      />

      <LandingJsonLd />

      <div className="min-h-screen bg-white text-gray-900">
        <LandingNavbar
          scrolled={scrolled}
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />
        <LandingHero stats={stats} />
        <LandingFeaturesGrid />
        <LandingDetailedFeatures />
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
