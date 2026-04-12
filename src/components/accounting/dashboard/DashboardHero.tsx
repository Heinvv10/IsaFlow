/**
 * DashboardHero — premium header for the accounting dashboard.
 * Pattern: dark gradient + dot-grid overlay + dual accent glows + stat strip.
 */

import { DM_Serif_Display } from 'next/font/google';
import { TrendingUp, FileText, Landmark, Clock } from 'lucide-react';

const serif = DM_Serif_Display({ subsets: ['latin'], weight: '400' });

export interface DashboardHeroStats {
  revenueMtd: number;
  outstandingInvoices: number;
  cashPosition: number;
}

export interface DashboardHeroProps {
  companyName: string;
  stats?: DashboardHeroStats;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `R\u00A0${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `R\u00A0${(n / 1_000).toFixed(1)}K`;
  return `R\u00A0${new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2 }).format(n)}`;
}

const PILLS = (s: DashboardHeroStats) => [
  { icon: TrendingUp, label: 'Revenue MTD',           value: fmt(s.revenueMtd),           accent: 'bg-teal-500/80'    },
  { icon: FileText,   label: 'Outstanding Invoices',  value: fmt(s.outstandingInvoices),  accent: 'bg-amber-500/80'   },
  { icon: Landmark,   label: 'Cash Position',         value: fmt(s.cashPosition),         accent: 'bg-emerald-500/80' },
  { icon: Clock,      label: 'Days to Close',         value: '—',                         accent: 'bg-slate-500/80'   },
] as const;

export function DashboardHero({ companyName, stats }: DashboardHeroProps) {
  const now   = new Date();
  const month = now.toLocaleString('en-ZA', { month: 'long' });
  const year  = now.getFullYear();

  return (
    <div className="relative overflow-hidden mb-0" role="banner">
      {/* Base gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900" />

      {/* Dot grid */}
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.5) 1px, transparent 0)', backgroundSize: '28px 28px' }}
      />

      {/* Accent glows */}
      <div className="absolute -top-20 -right-20 w-80 h-80 bg-teal-500/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-16 -left-16 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Content */}
      <div className="relative z-10 px-8 pt-10 pb-7 max-w-7xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-400 mb-2">
          Financial Overview · {month} {year}
        </p>

        <h1 className={`${serif.className} text-3xl sm:text-4xl text-white leading-tight`}>
          {companyName}
        </h1>

        <p className="mt-1.5 text-sm text-slate-400 font-medium tracking-wide">
          General Ledger, Journal Entries &amp; Financial Reports
        </p>

        <div className="border-t border-white/10 mt-5 mb-4" />

        {/* Stat strip */}
        <div className="flex flex-wrap gap-3">
          {stats
            ? PILLS(stats).map(({ icon: Icon, label, value, accent }) => (
                <div key={label} className="flex items-center gap-3 px-5 py-3 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm hover:bg-white/10 transition-colors">
                  <div className={`p-1.5 rounded-lg ${accent}`}>
                    <Icon className="h-3.5 w-3.5 text-white" />
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 leading-none mb-1">{label}</p>
                    <p className="text-sm font-bold text-white leading-none">{value}</p>
                  </div>
                </div>
              ))
            : Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-3 rounded-xl bg-white/5 border border-white/10">
                  <div className="w-7 h-7 rounded-lg bg-white/10 animate-pulse" />
                  <div className="space-y-1.5">
                    <div className="h-2 w-20 rounded bg-white/10 animate-pulse" />
                    <div className="h-3.5 w-24 rounded bg-white/10 animate-pulse" />
                  </div>
                </div>
              ))}
        </div>
      </div>
    </div>
  );
}
