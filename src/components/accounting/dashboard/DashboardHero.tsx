/**
 * DashboardHero — premium card header with integrated pill tab bar.
 * Rounded card, white border, extended gradient + dot-grid + teal glow.
 */

import { DM_Serif_Display } from 'next/font/google';
import { TrendingUp, FileText, Landmark, Clock, ArrowDown } from 'lucide-react';
import type { ElementType } from 'react';

const serif = DM_Serif_Display({ subsets: ['latin'], weight: '400' });

export interface DashboardHeroStats {
  revenueMtd: number;
  outstandingInvoices: number;
  cashPosition: number;
}

export interface HeroTab {
  id: string;
  label: string;
  icon: ElementType;
}

export interface DashboardHeroProps {
  companyName: string;
  loading?: boolean;
  stats?: DashboardHeroStats;
  tabs: HeroTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `R\u00A0${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `R\u00A0${(n / 1_000).toFixed(1)}K`;
  return `R\u00A0${new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2 }).format(n)}`;
}

const PILLS = (s: DashboardHeroStats) => [
  {
    icon: TrendingUp, label: 'Revenue MTD',
    value: fmt(s.revenueMtd),
    accent: 'bg-teal-500/80', valueColor: 'text-slate-900 dark:text-white',
    warning: false,
  },
  {
    icon: FileText, label: 'Outstanding Invoices',
    value: fmt(s.outstandingInvoices),
    accent: 'bg-amber-500/80', valueColor: 'text-slate-900 dark:text-white',
    warning: false,
  },
  {
    icon: Landmark, label: 'Cash Position',
    value: fmt(s.cashPosition),
    accent: s.cashPosition < 0 ? 'bg-red-500/80' : 'bg-emerald-500/80',
    valueColor: s.cashPosition < 0 ? 'text-red-700 dark:text-red-300' : 'text-slate-900 dark:text-white',
    warning: s.cashPosition < 0,
  },
  {
    icon: Clock, label: 'Days to Close',
    value: '—',
    accent: 'bg-slate-500/80', valueColor: 'text-slate-900 dark:text-white',
    warning: false,
  },
];

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
  companyName, loading = false, stats, tabs, activeTab, onTabChange,
}: DashboardHeroProps) {
  const now   = new Date();
  const month = now.toLocaleString('en-ZA', { month: 'long' });
  const year  = now.getFullYear();
  const tabHero = TAB_HERO[activeTab];
  const eyebrow = tabHero ? tabHero.eyebrow : `Financial Overview · ${month} ${year}`;
  const title = tabHero ? tabHero.title : companyName;
  const subtitle = tabHero ? tabHero.subtitle : 'General Ledger, Journal Entries & Financial Reports';

  return (
    <div
      className="relative overflow-hidden rounded-3xl border border-slate-900/10 dark:border-white/10"
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
        <p className="text-xs font-semibold uppercase tracking-[0.2em] mb-3" style={{ color: 'var(--ff-brand-light)' }}>
          {eyebrow}
        </p>

        {loading ? (
          <div className="h-10 w-64 rounded-lg bg-white/10 animate-pulse mb-2" />
        ) : (
          <h1 className={`${serif.className} text-3xl sm:text-4xl text-slate-900 dark:text-white leading-tight`}>
            {title}
          </h1>
        )}

        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400 font-medium tracking-wide">
          {subtitle}
        </p>

        <div className="border-t border-slate-900/10 dark:border-white/10 mt-6 mb-5" />

        {/* Stat pills — only show on overview tab. Other tabs (Journal Entries,
            Chart of Accounts, etc.) have their own data and should not display
            cross-cutting financial KPIs. */}
        {activeTab === 'overview' && <div className="flex flex-wrap gap-3 mb-7">
          {stats
            ? PILLS(stats).map(({ icon: Icon, label, value, accent, valueColor, warning }) => (
                <div key={label} className="flex items-center gap-3 px-5 py-3.5 rounded-xl bg-slate-900/5 dark:bg-white/5 border border-slate-900/10 dark:border-white/10 backdrop-blur-sm hover:bg-slate-900/10 dark:hover:bg-white/10 transition-colors">
                  <div className={`p-1.5 rounded-lg ${accent}`}>
                    <Icon className="h-3.5 w-3.5 text-slate-900 dark:text-white" />
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400 leading-none mb-1.5">{label}</p>
                    <p className={`text-sm font-bold leading-none flex items-center gap-1 ${valueColor}`}>
                      {warning && <ArrowDown className="h-3 w-3" aria-label="Negative" />}
                      {value}
                    </p>
                  </div>
                </div>
              ))
            : Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-3.5 rounded-xl bg-slate-900/5 dark:bg-white/5 border border-slate-900/10 dark:border-white/10">
                  <div className="w-7 h-7 rounded-lg bg-slate-900/10 dark:bg-white/10 animate-pulse" />
                  <div className="space-y-1.5">
                    <div className="h-2 w-20 rounded bg-slate-900/10 dark:bg-white/10 animate-pulse" />
                    <div className="h-3.5 w-24 rounded bg-slate-900/10 dark:bg-white/10 animate-pulse" />
                  </div>
                </div>
              ))}
        </div>}

        {/* Pill tab bar — integrated into the card */}
        <div
          className="flex items-center gap-1 backdrop-blur-sm rounded-xl p-1 w-fit"
          style={{ background: 'var(--ff-canvas-base)', border: '1px solid var(--ff-canvas-border)' }}
        >
          {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                style={isActive ? { background: 'var(--ff-brand-dark)' } : {}}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${isActive ? 'text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-900/5 dark:hover:bg-white/5' }`}
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
