import { useState, useEffect } from 'react';
import { ArrowRight, PlayCircle } from 'lucide-react';
import { APP_URL } from './landingData';
interface LandingStats {
  transactionAmount: number;
  businessCount: number;
  invoiceCount: number;
}

function formatRand(amount: number): string {
  if (amount >= 1_000_000_000) return `R ${(amount / 1_000_000_000).toFixed(1)}B+`;
  if (amount >= 1_000_000)     return `R ${(amount / 1_000_000).toFixed(0)}M+`;
  if (amount >= 1_000)         return `R ${(amount / 1_000).toFixed(0)}K+`;
  return `R ${amount.toFixed(0)}`;
}

function formatCount(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K+`;
  return `${n}+`;
}

interface StatItem { value: string; label: string }

function buildStats(data: LandingStats): StatItem[] {
  return [
    { value: formatRand(data.transactionAmount), label: 'Transactions Processed' },
    { value: formatCount(data.businessCount),    label: 'Businesses' },
    { value: formatCount(data.invoiceCount),     label: 'Invoices Processed' },
  ];
}

const FALLBACK_STATS: StatItem[] = [
  { value: 'R 144M+', label: 'Transactions Processed' },
  { value: '1+',      label: 'Businesses' },
  { value: '1.2K+',   label: 'Invoices Processed' },
];

export function LandingHero() {
  const [logoVisible, setLogoVisible] = useState(false);
  const [stats, setStats] = useState<StatItem[]>(FALLBACK_STATS);

  useEffect(() => {
    fetch('/api/landing-stats')
      .then((r) => r.json())
      .then((data: LandingStats) => setStats(buildStats(data)))
      .catch(() => { /* keep fallback */ });
  }, []);

  return (
    <>
      {/* ── Video Hero ── */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
        {/* Video background — plays once, no loop */}
        <video
          autoPlay
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover hidden sm:block"
          poster="/landing/seq2-1-midnight.png"
          onEnded={() => setLogoVisible(true)}
        >
          <source src="/landing/IsaFlow Hero Vid.mp4" type="video/mp4" />
        </video>

        {/* Mobile static fallback */}
        <div
          className="absolute inset-0 bg-cover bg-center sm:hidden"
          style={{ backgroundImage: 'url(/landing/seq2-1-midnight.png)' }}
        />

        {/* Dark gradient overlay */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to bottom, rgba(5,10,15,0.85) 0%, rgba(5,10,15,0.5) 50%, rgba(5,10,15,0.9) 100%)',
          }}
        />

        {/* ISAFlow logo — slides in when video ends, sits in top 25% */}
        <div
          className={`absolute inset-x-0 top-0 h-[42%] z-[5] flex items-center justify-center pointer-events-none transition-all duration-1000 ease-out ${ logoVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4' }`}
        >
          <img
            src="/BI/logo-primary-transparent.png"
            alt="ISAFlow"
            className="w-56 sm:w-80 lg:w-96 drop-shadow-2xl"
          />
        </div>

        {/* Hero content */}
        <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center pt-20">
          {/* Eyebrow label */}
          <p className="text-xs font-semibold tracking-[0.2em] uppercase text-white/50 mb-6">
            Accounting Software
          </p>

          {/* Main headline */}
          <h1 className="text-5xl sm:text-7xl lg:text-8xl font-black tracking-tight leading-[1.02] text-slate-900 dark:text-white mb-6">
            Your finances,
            <br />
            finally clear.
          </h1>

          {/* Subheadline */}
          <p className="text-lg sm:text-xl text-white/60 leading-relaxed max-w-2xl mx-auto mb-10">
            Invoicing, bank reconciliation, tax compliance and payroll —
            everything your business needs in one platform.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
            <a
              href={`${APP_URL}/register`}
              className="inline-flex items-center gap-2 px-8 py-4 text-base font-bold text-slate-900 bg-white rounded-xl hover:bg-white/90 transition-all shadow-2xl"
            >
              Start Free Trial <ArrowRight className="w-4 h-4" />
            </a>
            <a
              href="#features"
              className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-slate-900 dark:text-white border border-white/30 rounded-xl hover:bg-white/5 transition-all"
            >
              <PlayCircle className="w-4 h-4" /> Watch Demo
            </a>
          </div>

          {/* Trust line */}
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-white/45">
            <span>✓ 30-day free trial</span>
            <span>✓ No credit card required</span>
            <span>✓ Full tax compliance</span>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 animate-bounce">
          <div className="w-5 h-8 border-2 border-white/20 rounded-full flex items-start justify-center pt-1">
            <div className="w-1 h-2 bg-white/40 rounded-full" />
          </div>
        </div>
      </section>

      {/* ── Stats Bar ── */}
      <section className="bg-white dark:bg-gray-900 py-14">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 text-center">
            {stats.map((s) => (
              <div key={s.label}>
                <p className="text-4xl lg:text-5xl font-extrabold text-slate-900 dark:text-white mb-1">{s.value}</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
