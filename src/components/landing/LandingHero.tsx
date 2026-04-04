import { ArrowRight, PlayCircle, TrendingUp, BadgeCheck, BookOpen, Zap } from 'lucide-react';
import { APP_URL, STATS } from './landingData';

export function LandingHero() {
  return (
    <>
      {/* Hero */}
      <section className="relative pt-32 pb-20 lg:pt-44 lg:pb-32 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-white to-teal-50/40" />
        <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-gradient-to-bl from-teal-100/50 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />
        <div className="absolute bottom-0 left-0 w-[600px] h-[600px] bg-gradient-to-tr from-blue-100/30 to-transparent rounded-full blur-3xl translate-y-1/2 -translate-x-1/3" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div className="max-w-xl">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-teal-50 border border-teal-200 text-teal-700 text-xs font-semibold mb-6 tracking-wide">
                <Zap className="w-3.5 h-3.5" /> BUILT FOR SOUTH AFRICA
              </div>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6">
                Accounting that{' '}
                <span className="bg-gradient-to-r from-teal-600 to-cyan-500 bg-clip-text text-transparent">
                  works for you
                </span>
              </h1>
              <p className="text-lg sm:text-xl text-gray-600 leading-relaxed mb-8">
                Invoicing, bank reconciliation, VAT returns, SARS compliance, payroll — everything your business needs in one powerful, beautifully simple platform.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <a href={`${APP_URL}/register`} className="inline-flex items-center justify-center gap-2 px-7 py-3.5 text-base font-semibold text-white bg-gradient-to-r from-teal-600 to-teal-500 rounded-xl hover:from-teal-700 hover:to-teal-600 transition-all shadow-xl shadow-teal-500/25 hover:shadow-teal-500/40">
                  Start Free Trial <ArrowRight className="w-4 h-4" />
                </a>
                <a href="#features" className="inline-flex items-center justify-center gap-2 px-7 py-3.5 text-base font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm">
                  <PlayCircle className="w-4 h-4" /> See How It Works
                </a>
              </div>
              <p className="mt-4 text-sm text-gray-500">14-day free trial &middot; No credit card required</p>
              <p className="mt-2 text-sm text-gray-500">Already have an account? <a href={`${APP_URL}/login`} className="text-teal-600 font-medium hover:underline">Sign in</a></p>
            </div>

            <div className="relative">
              <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-gray-900/10 border border-gray-200/50">
                <img
                  src="/landing/hero-dashboard.png"
                  alt="ISAFlow Dashboard"
                  className="w-full"
                  onError={(e) => {
                    const target = e.currentTarget;
                    target.style.display = 'none';
                    const fallback = target.nextElementSibling as HTMLElement;
                    if (fallback) fallback.style.display = 'flex';
                  }}
                />
                <div className="hidden aspect-[16/10] bg-gradient-to-br from-slate-800 via-slate-900 to-gray-900 items-center justify-center" style={{ display: 'none' }}>
                  <div className="text-center">
                    <BookOpen className="w-16 h-16 text-teal-400 mx-auto mb-4" />
                    <p className="text-teal-300 text-lg font-semibold">ISAFlow Dashboard</p>
                    <p className="text-gray-500 text-sm mt-1">Run image generation script to populate</p>
                  </div>
                </div>
              </div>
              <div className="absolute -bottom-6 -left-6 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
                    <TrendingUp className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Revenue</p>
                    <p className="text-lg font-bold text-gray-900">R 1.2M</p>
                  </div>
                </div>
              </div>
              <div className="absolute -top-4 -right-4 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-teal-50 flex items-center justify-center">
                    <BadgeCheck className="w-5 h-5 text-teal-600" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Reconciled</p>
                    <p className="text-lg font-bold text-gray-900">98.7%</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats bar */}
      <section className="relative py-12 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {STATS.map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-3xl lg:text-4xl font-extrabold text-white">{s.value}</p>
                <p className="text-sm text-gray-400 mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
