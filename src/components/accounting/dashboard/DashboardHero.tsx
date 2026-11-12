/**
 * DashboardHero — premium card header with integrated pill tab bar.
 * Rounded card, white border, extended gradient + dot-grid + teal glow.
 */

import localFont from 'next/font/local';
import type { ElementType } from 'react';
import { formatDisplayMonthYearLong } from '@/utils/dateFormat';

// Self-hosted (OFL, src/assets/fonts/OFL-DMSerifDisplay.txt): the Google-hosted loader fetched it at build time.
const serif = localFont({
  src: '../../../assets/fonts/DMSerifDisplay-latin-regular.woff2',
  weight: '400',
  style: 'normal',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
});

export interface HeroTab {
  id: string;
  label: string;
  icon: ElementType;
}

export interface DashboardHeroProps {
  companyName: string;
  loading?: boolean;
  tabs: HeroTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

// Per-tab hero identity. When the user navigates via a top-nav menu item that
// resolves to /accounting?tab=X, the hero should advertise the tab they're on
// — not the unchanged "Financial Overview · ISAFlow Demo" header which makes
// the navigation feel broken.
const TAB_HERO: Record<string, { eyebrow: string; title: string; subtitle: string }> = {
  'chart-of-accounts': {
    eyebrow: 'General Ledger',
    title: 'Chart of Accounts',
    subtitle: 'GL account structure, normal balances and VAT defaults',
  },
  'journal-entries': {
    eyebrow: 'General Ledger',
    title: 'Journal Entries',
    subtitle: 'Process and review manual journals',
  },
  'fiscal-periods': {
    eyebrow: 'Period Close',
    title: 'Fiscal Periods',
    subtitle: 'Open, close and lock financial periods',
  },
  'reports': {
    eyebrow: 'Reporting',
    title: 'Financial Reports',
    subtitle: 'Run, save and export financial statements',
  },
};

export function DashboardHero({
  companyName, loading = false, tabs, activeTab, onTabChange,
}: DashboardHeroProps) {
  const now   = new Date();
  const tabHero = TAB_HERO[activeTab];
  const eyebrow = tabHero ? tabHero.eyebrow : `Financial Overview · ${formatDisplayMonthYearLong(now)}`;
  const title = tabHero ? tabHero.title : companyName;
  const subtitle = tabHero ? tabHero.subtitle : 'General Ledger, Journal Entries & Financial Reports';

  return (
    <div
      className="relative overflow-hidden rounded-3xl border border-slate-900/10 dark:border-white/10 [contain:paint]"
      style={{ background: `linear-gradient(135deg, var(--ff-canvas-raised) 0%, var(--ff-canvas-mid) 50%, var(--ff-canvas-base) 100%)` }}
      role="banner"
    >

      {/* Dot grid — covers entire card */}
      <div
        className="absolute inset-0"
        style={{
          opacity: 0.18,
          backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.4) 1px, transparent 0)',
          backgroundSize: '28px 28px',
        }}
      />

      {/* Large brand glow */}
      <div
        className="absolute top-1/2 -right-32 w-[700px] h-[700px] rounded-full blur-3xl pointer-events-none"
        style={{ background: 'var(--ff-brand-muted)', transform: 'translateY(-50%)' }}
      />
      {/* Secondary upper-right glow */}
      <div
        className="absolute -top-10 right-16 w-64 h-64 rounded-full blur-2xl pointer-events-none"
        style={{ background: 'var(--ff-brand-subtle)' }}
      />

      {/* Content */}
      <div className="relative z-10 px-8 pt-12 pb-6 max-w-7xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] mb-3" style={{ color: 'var(--ff-brand-eyebrow)' }}>
          {eyebrow}
        </p>

        {loading ? (
          // The h1's own line box (text-2xl, leading-tight = 30px), so the subtitle does not move when it lands.
          <div className="h-[1.875rem] w-64 rounded-lg bg-white/10 animate-pulse" />
        ) : (
          <h1 className={`${serif.className} text-2xl text-slate-900 dark:text-white leading-tight`}>
            {title}
          </h1>
        )}

        <p className="mt-2 text-sm text-ink-muted font-medium tracking-wide">
          {subtitle}
        </p>

        <div className="border-t border-slate-900/10 dark:border-white/10 mt-6 mb-5" />

        {/* Pill tab bar — integrated into the card */}
        {/* Scrolls sideways when narrower than the tabs (390 px phones). */}
        <div
          role="tablist"
          aria-label="Dashboard sections"
          className="flex items-center gap-1 backdrop-blur-sm rounded-xl p-1 w-fit max-w-full overflow-x-auto"
          style={{ background: 'var(--ff-canvas-base)', border: '1px solid var(--ff-canvas-border)' }}
        >
          {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onTabChange(tab.id)}
                style={isActive ? { background: 'var(--ff-brand-dark)' } : {}}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap shrink-0 ${isActive ? 'text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-900/5 dark:hover:bg-white/5' }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
