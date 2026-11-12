import { useEffect, useState, type ReactNode } from 'react';
import { LandingNavbar } from './LandingNavbar';
import { LandingFooter } from './LandingPricingTestimonialsFooter';

/** Navbar, white page wrapper and footer for a public marketing page. */
export function MarketingPageShell({ children }: { children: ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <LandingNavbar
        scrolled={scrolled}
        mobileMenuOpen={mobileMenuOpen}
        onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />
      {children}
      <LandingFooter />
    </div>
  );
}

/** Dark top band of a marketing page: eyebrow, h1 and an optional sub line and actions. */
export function MarketingHeroBand({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <section className="relative bg-[#050a0f] text-white pt-32 pb-16 lg:pt-40 lg:pb-20 overflow-hidden">
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(20,184,166,0.18),transparent_70%)]" />
      <div className="relative max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <p className="text-sm font-semibold text-teal-400 tracking-widest uppercase mb-4">{eyebrow}</p>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.05] mb-4">{title}</h1>
        {children}
      </div>
    </section>
  );
}

/** Eyebrow and h2 for a section on a white or grey marketing surface. */
export function MarketingSectionHeading({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <>
      {eyebrow && <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">{eyebrow}</p>}
      <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4 text-gray-900">{title}</h2>
    </>
  );
}
