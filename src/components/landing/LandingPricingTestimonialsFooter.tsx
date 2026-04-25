import { Check, Star, ChevronDown, ArrowRight } from 'lucide-react';
import { APP_URL, PRICING_TIERS, TESTIMONIALS, FAQ_ITEMS, TRUST_COMPANIES } from './landingData';

interface FAQProps {
  openFaq: number | null;
  onToggle: (i: number) => void;
}

// ── Trust Bar ──────────────────────────────────────────────────────────────
export function LandingTrustBar() {
  return (
    <section className="bg-white py-12 border-b border-gray-100">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <p className="text-xs font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-400 mb-8">
          Trusted by businesses worldwide
        </p>
        <div className="flex flex-wrap items-center justify-center gap-8 lg:gap-12">
          {TRUST_COMPANIES.map((name) => (
            <div
              key={name}
              className="text-sm font-semibold text-gray-700 dark:text-gray-300 tracking-wide"
            >
              {name}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Pricing ────────────────────────────────────────────────────────────────
export function LandingPricing() {
  return (
    <section id="pricing" className="py-20 lg:py-28 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">
            Pricing
          </p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4 text-gray-900">
            Plans that grow with your business
          </h2>
          <p className="text-lg text-gray-500">
            Start with a 14-day free trial on any plan. No credit card required.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {PRICING_TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`relative rounded-2xl p-8 ${ tier.popular ? 'bg-gray-900 text-slate-900 dark:text-white shadow-2xl shadow-gray-900/20 ring-2 ring-teal-500' : 'bg-white border border-gray-200 shadow-sm' }`}
            >
              {tier.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1 px-4 py-1.5 rounded-full bg-gradient-to-r from-teal-500 to-cyan-500 text-slate-900 dark:text-white text-xs font-bold shadow-lg">
                    <Star className="w-3 h-3 fill-white" /> MOST POPULAR
                  </span>
                </div>
              )}
              <h3 className={`text-lg font-semibold mb-1 ${tier.popular ? 'text-white' : 'text-gray-900'}`}>
                {tier.name}
              </h3>
              <p className={`text-sm mb-6 ${tier.popular ? 'text-gray-400' : 'text-gray-500'}`}>
                {tier.desc}
              </p>
              <div className="flex items-baseline gap-1 mb-8">
                <span className={`text-4xl font-extrabold ${tier.popular ? 'text-white' : 'text-gray-900'}`}>
                  {tier.price}
                </span>
                <span className={`text-sm ${tier.popular ? 'text-gray-400' : 'text-gray-500'}`}>
                  {tier.period}
                </span>
              </div>
              <ul className="space-y-3 mb-8">
                {tier.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2.5">
                    <Check className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tier.popular ? 'text-teal-400' : 'text-teal-500'}`} />
                    <span className={`text-sm ${tier.popular ? 'text-gray-300' : 'text-gray-600'}`}>{feat}</span>
                  </li>
                ))}
              </ul>
              <a
                href={tier.name === 'Enterprise' ? '#contact' : `${APP_URL}/register`}
                className={`block w-full text-center py-3 rounded-xl text-sm font-semibold transition-all ${ tier.popular ? 'bg-gradient-to-r from-teal-500 to-cyan-500 text-slate-900 dark:text-white hover:from-teal-600 hover:to-cyan-600 shadow-lg shadow-teal-500/25' : 'bg-gray-900 text-slate-900 dark:text-white hover:bg-gray-800' }`}
              >
                {tier.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Testimonials ───────────────────────────────────────────────────────────
export function LandingTestimonials() {
  const featured = TESTIMONIALS.find((t) => t.featured);
  const supporting = TESTIMONIALS.filter((t) => !t.featured);

  return (
    <section id="testimonials" className="py-20 lg:py-28 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">
            Testimonials
          </p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-900">
            Loved by finance teams
          </h2>
        </div>

        {/* Featured testimonial */}
        {featured && (
          <div className="bg-white dark:bg-gray-900 rounded-3xl p-10 lg:p-14 mb-8 text-center max-w-4xl mx-auto">
            <div className="flex justify-center mb-6">
              {Array.from({ length: featured.stars }).map((_, i) => (
                <Star key={i} className="w-5 h-5 text-teal-400 fill-teal-400" />
              ))}
            </div>
            <blockquote className="text-xl lg:text-2xl font-medium text-slate-900 dark:text-white leading-relaxed mb-8">
              &quot;{featured.quote}&quot;
            </blockquote>
            {featured.metric && (
              <div className="inline-block px-4 py-2 bg-teal-500/20 text-teal-400 text-sm font-semibold rounded-full mb-6">
                {featured.metric}
              </div>
            )}
            <div>
              <p className="font-semibold text-slate-900 dark:text-white">{featured.name}</p>
              <p className="text-sm text-gray-600 dark:text-gray-400">{featured.role}, {featured.company}</p>
            </div>
          </div>
        )}

        {/* Supporting testimonials */}
        <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {supporting.map((t) => (
            <div key={t.name} className="bg-white border border-gray-100 rounded-2xl p-8 shadow-sm border-l-4 border-l-teal-500">
              <div className="flex mb-4">
                {Array.from({ length: t.stars }).map((_, i) => (
                  <Star key={i} className="w-4 h-4 text-teal-500 fill-teal-500" />
                ))}
              </div>
              <blockquote className="text-gray-700 leading-relaxed mb-6 text-sm">
                &quot;{t.quote}&quot;
              </blockquote>
              <div>
                <p className="font-semibold text-gray-900 text-sm">{t.name}</p>
                <p className="text-xs text-gray-600 dark:text-gray-400">{t.role}, {t.company}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── FAQ ────────────────────────────────────────────────────────────────────
export function LandingFAQ({ openFaq, onToggle }: FAQProps) {
  return (
    <section id="faq" className="py-20 lg:py-28 bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">FAQ</p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-900">
            Common questions
          </h2>
        </div>

        <div className="space-y-3">
          {FAQ_ITEMS.map((item, i) => (
            <div key={i} className="bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm">
              <button
                onClick={() => onToggle(i)}
                className="w-full flex items-center justify-between px-6 py-5 text-left"
              >
                <span className="font-semibold text-gray-900 text-sm">{item.q}</span>
                <ChevronDown
                  className={`w-5 h-5 text-gray-600 dark:text-gray-400 flex-shrink-0 ml-4 transition-transform duration-200 ${ openFaq === i ? 'rotate-180' : '' }`}
                />
              </button>
              {openFaq === i && (
                <div className="px-6 pb-5">
                  <p className="text-sm text-gray-600 leading-relaxed">{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Closing CTA ────────────────────────────────────────────────────────────
export function LandingCTA() {
  return (
    <section className="py-20 lg:py-28 bg-white dark:bg-gray-900">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-4xl sm:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-4">
          Ready to take control<br />of your finances?
        </h2>
        <p className="text-lg text-gray-600 dark:text-gray-400 mb-10">
          Start your free 14-day trial today. No credit card required.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href={`${APP_URL}/register`}
            className="inline-flex items-center gap-2 px-8 py-4 text-base font-bold text-slate-900 bg-white rounded-xl hover:bg-white/90 transition-all shadow-2xl"
          >
            Start Free Trial <ArrowRight className="w-4 h-4" />
          </a>
          <a
            href="#contact"
            className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-slate-900 dark:text-white border border-white/30 rounded-xl hover:bg-white/5 transition-all"
          >
            Book a Demo
          </a>
        </div>
      </div>
    </section>
  );
}

// ── Footer ─────────────────────────────────────────────────────────────────
export function LandingFooter() {
  return (
    <footer className="bg-white dark:bg-gray-900 border-t border-white/10 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="ISAFlow" className="h-8 w-auto brightness-0 invert opacity-60" />
            <span className="text-sm text-gray-500">© {new Date().getFullYear()} ISAFlow. All rights reserved.</span>
          </div>
          <div className="flex gap-6 text-sm text-gray-500">
            <a href="/privacy" className="hover:text-white transition-colors">Privacy</a>
            <a href="/terms" className="hover:text-white transition-colors">Terms</a>
            <a href="/security" className="hover:text-white transition-colors">Security</a>
            <a href={`${APP_URL}/login`} className="hover:text-white transition-colors">Sign In</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
