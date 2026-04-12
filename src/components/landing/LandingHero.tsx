import { ArrowRight, PlayCircle } from 'lucide-react';
import { APP_URL, STATS } from './landingData';

export function LandingHero() {
  return (
    <>
      {/* ── Video Hero ── */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
        {/* Video background — hidden on mobile, static image shown instead */}
        <video
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 w-full h-full object-cover hidden sm:block"
          poster="/landing/seq2-1-midnight.png"
        >
          <source src="/landing/IsaFlow Video.mp4" type="video/mp4" />
        </video>

        {/* Mobile static fallback */}
        <div
          className="absolute inset-0 bg-cover bg-center sm:hidden"
          style={{ backgroundImage: 'url(/landing/seq2-1-midnight.png)' }}
        />

        {/* Dark gradient overlay — darkens top/bottom for readability, lets city show on sides */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to bottom, rgba(5,10,15,0.85) 0%, rgba(5,10,15,0.5) 50%, rgba(5,10,15,0.9) 100%)',
          }}
        />

        {/* Hero content */}
        <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center pt-20">
          {/* Eyebrow label */}
          <p className="text-xs font-semibold tracking-[0.2em] uppercase text-white/50 mb-6">
            Accounting Software
          </p>

          {/* Main headline */}
          <h1 className="text-5xl sm:text-7xl lg:text-8xl font-black tracking-tight leading-[1.02] text-white mb-6">
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
              className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-white border border-white/30 rounded-xl hover:bg-white/5 transition-all"
            >
              <PlayCircle className="w-4 h-4" /> Watch Demo
            </a>
          </div>

          {/* Trust line */}
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-white/45">
            <span>✓ 14-day free trial</span>
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
      <section className="bg-gray-900 py-14">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 text-center">
            {STATS.map((s) => (
              <div key={s.label}>
                <p className="text-4xl lg:text-5xl font-extrabold text-white mb-1">{s.value}</p>
                <p className="text-sm text-gray-400">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
