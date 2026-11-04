import { Check, Star, ChevronDown, ArrowRight } from 'lucide-react';
import { APP_URL, PRICING_TIERS, FAQ_ITEMS } from './landingData';

interface FAQProps {
  openFaq: number | null;
  onToggle: (i: number) => void;
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
            Start with a 30-day free trial on any plan. No credit card required.
          </p>
          <p className="text-sm text-gray-400 mt-2">All prices include 15% VAT.</p>
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
                href={tier.cta === 'Contact Sales' ? '/contact' : `${APP_URL}/register`}
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
                id={`faq-q-${i}`}
                aria-expanded={openFaq === i}
                aria-controls={`faq-a-${i}`}
                className="w-full flex items-center justify-between px-6 py-5 text-left"
              >
                <span className="font-semibold text-gray-900 text-sm">{item.q}</span>
                <ChevronDown
                  className={`w-5 h-5 text-gray-600 dark:text-gray-400 flex-shrink-0 ml-4 transition-transform duration-200 ${ openFaq === i ? 'rotate-180' : '' }`}
                />
              </button>
              {/* Always in the DOM (hidden when closed) so the answer text is crawlable. */}
              <div className="px-6 pb-5" id={`faq-a-${i}`} role="region" aria-labelledby={`faq-q-${i}`} hidden={openFaq !== i}>
                <p className="text-sm text-gray-600 leading-relaxed">{item.a}</p>
              </div>
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
          Start your free 30-day trial today. No credit card required.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href={`${APP_URL}/register`}
            className="inline-flex items-center gap-2 px-8 py-4 text-base font-bold text-slate-900 bg-white rounded-xl hover:bg-white/90 transition-all shadow-2xl"
          >
            Start Free Trial <ArrowRight className="w-4 h-4" />
          </a>
          <a
            href="/contact"
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
        <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
          <div>
            <img src="/logo.png" alt="IsaFlow" className="h-8 w-auto brightness-0 invert opacity-60" />
            <p className="mt-4 max-w-sm text-sm text-slate-600 dark:text-slate-400">
              © {new Date().getFullYear()} Brightsphere Technologies (Pty) Ltd, trading as IsaFlow. All rights reserved.
            </p>
          </div>
          <div className="text-sm">
            <p className="font-semibold text-gray-900 dark:text-white">Product</p>
            <div className="mt-3 space-y-2 text-slate-600 dark:text-slate-400">
              <a href="/#features" className="block hover:text-white transition-colors">Features</a>
              <a href="/pricing" className="block hover:text-white transition-colors">Pricing</a>
            </div>
          </div>
          <div className="text-sm">
            <p className="font-semibold text-gray-900 dark:text-white">Resources</p>
            <div className="mt-3 space-y-2 text-slate-600 dark:text-slate-400">
              <a href="/blog" className="block hover:text-white transition-colors">Blog</a>
              <a href="/help" className="block hover:text-white transition-colors">Help</a>
              <a href="/#faq" className="block hover:text-white transition-colors">FAQ</a>
            </div>
          </div>
          <div className="text-sm">
            <p className="font-semibold text-gray-900 dark:text-white">Company</p>
            <div className="mt-3 space-y-2 text-slate-600 dark:text-slate-400">
              <a href="/contact" className="block hover:text-white transition-colors">Contact</a>
            </div>
          </div>
          <div className="text-sm">
            <p className="font-semibold text-gray-900 dark:text-white">Legal</p>
            <div className="mt-3 space-y-2 text-slate-600 dark:text-slate-400">
              <a href="/privacy" className="block hover:text-white transition-colors">Privacy</a>
              <a href="/terms" className="block hover:text-white transition-colors">Terms</a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
