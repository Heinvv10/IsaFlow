/**
 * Page frame for the blog, matching the landing page: dark navbar, a dark hero band,
 * a white body with dark text, and the landing footer.
 */
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingFooter } from '@/components/landing/LandingPricingTestimonialsFooter';
import { formatBlogDate } from '@/lib/blog/format';
import type { BlogStatus } from '@/lib/blog/visibility';

interface ShellProps {
  band: ReactNode;
  children: ReactNode;
}

export function BlogShell({ band, children }: ShellProps) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
      <section className="relative overflow-hidden bg-[#050a0f] text-white pt-32 pb-16 lg:pt-40">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(20,184,166,0.18),transparent_60%)]"
        />
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">{band}</div>
      </section>
      <main>{children}</main>
      <LandingFooter />
    </div>
  );
}

export function Breadcrumb({ trail }: { trail: { name: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6 text-sm text-white/70">
      <ol className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        {trail.map((t, i) => (
          <li key={t.name} className={`flex items-center gap-1.5 ${t.href ? 'shrink-0' : 'min-w-0'}`}>
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden="true" />}
            {t.href ? (
              <Link href={t.href} className="hover:text-teal-300 transition-colors">
                {t.name}
              </Link>
            ) : (
              <span aria-current="page" className="truncate text-white/90">
                {t.name}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Shown on preview builds only: production never renders a draft or scheduled post. */
export function PreviewBanner({ status, publishDate }: { status: BlogStatus; publishDate: string }) {
  if (status === 'published') return null;
  const text =
    status === 'draft'
      ? 'DRAFT: not visible in production until draft is set to false.'
      : `SCHEDULED: goes live on ${formatBlogDate(publishDate)} (on the first build or revalidation after that date).`;
  return (
    <div role="status" className="mb-6 inline-flex rounded-lg border border-amber-300/60 bg-amber-400/15 px-3 py-1.5 text-sm font-semibold text-amber-200">
      {text}
    </div>
  );
}

export function Chip({ children, href, tone = 'light' }: { children: ReactNode; href?: string; tone?: 'light' | 'dark' }) {
  const cls =
    tone === 'dark'
      ? 'border-teal-400/40 bg-teal-400/10 text-teal-200 hover:bg-teal-400/20'
      : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-teal-300 hover:text-teal-700';
  const base = `inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${cls}`;
  return href ? (
    <Link href={href} className={base}>
      {children}
    </Link>
  ) : (
    <span className={base}>{children}</span>
  );
}
