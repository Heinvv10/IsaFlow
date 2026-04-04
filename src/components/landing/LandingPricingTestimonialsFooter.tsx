import { Check, Star, ChevronDown, Shield, ArrowRight } from 'lucide-react';
import { APP_URL, PRICING_TIERS, TESTIMONIALS, FAQ_ITEMS } from './landingData';

interface FAQProps {
  openFaq: number | null;
  onToggle: (i: number) => void;
}

export function LandingPricing() {
  return (
    <section id="pricing" className="py-20 lg:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-wide uppercase mb-3">Simple Pricing</p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">Plans that grow with your business</h2>
          <p className="text-lg text-gray-600">Start with a 14-day free trial on any plan. No credit card required.</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {PRICING_TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`relative rounded-2xl p-8 ${
                tier.popular
                  ? 'bg-gray-900 text-white shadow-2xl shadow-gray-900/20 scale-[1.02] ring-2 ring-teal-500'
                  : 'bg-white border border-gray-200 shadow-sm'
              }`}
            >
              {tier.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1 px-4 py-1.5 rounded-full bg-gradient-to-r from-teal-500 to-cyan-500 text-white text-xs font-bold shadow-lg">
                    <Star className="w-3 h-3" /> MOST POPULAR
                  </span>
                </div>
              )}
              <h3 className={`text-lg font-semibold mb-1 ${tier.popular ? 'text-white' : 'text-gray-900'}`}>{tier.name}</h3>
              <p className={`text-sm mb-6 ${tier.popular ? 'text-gray-400' : 'text-gray-500'}`}>{tier.desc}</p>
              <div className="flex items-baseline gap-1 mb-8">
                <span className={`text-4xl font-extrabold ${tier.popular ? 'text-white' : 'text-gray-900'}`}>{tier.price}</span>
                <span className={`text-sm ${tier.popular ? 'text-gray-400' : 'text-gray-500'}`}>{tier.period}</span>
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
                className={`block w-full text-center py-3 rounded-xl text-sm font-semibold transition-all ${
                  tier.popular
                    ? 'bg-gradient-to-r from-teal-500 to-cyan-500 text-white hover:from-teal-600 hover:to-cyan-600 shadow-lg shadow-teal-500/25'
                    : 'bg-gray-900 text-white hover:bg-gray-800'
                }`}
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

export function LandingTestimonials() {
  return (
    <section id="testimonials" className="py-20 lg:py-28 bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-wide uppercase mb-3">Testimonials</p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">Trusted by businesses across South Africa</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-8">
          {TESTIMONIALS.map((t) => (
            <div key={t.name} className="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">
              <div className="flex gap-1 mb-4">
                {Array.from({ length: t.stars }).map((_, i) => (
                  <Star key={i} className="w-4 h-4 text-amber-400 fill-amber-400" />
                ))}
              </div>
              <p className="text-gray-700 leading-relaxed mb-6 text-sm">&ldquo;{t.quote}&rdquo;</p>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-teal-500 to-cyan-500 flex items-center justify-center text-white font-bold text-sm">
                  {t.name.split(' ').map(n => n[0]).join('')}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                  <p className="text-xs text-gray-500">{t.role}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function LandingFAQ({ openFaq, onToggle }: FAQProps) {
  return (
    <section id="faq" className="py-20 lg:py-28">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-wide uppercase mb-3">FAQ</p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Common questions</h2>
        </div>
        <div className="space-y-3">
          {FAQ_ITEMS.map((item, i) => (
            <div key={i} className="border border-gray-200 rounded-xl overflow-hidden">
              <button
                onClick={() => onToggle(i)}
                className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
              >
                <span className="text-sm font-semibold text-gray-900 pr-4">{item.q}</span>
                <ChevronDown className={`w-5 h-5 text-gray-400 flex-shrink-0 transition-transform duration-200 ${openFaq === i ? 'rotate-180' : ''}`} />
              </button>
              {openFaq === i && (
                <div className="px-6 pb-4">
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

export function LandingCTA() {
  return (
    <section className="py-20 lg:py-28 bg-gray-900 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-teal-900/30 to-transparent" />
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-teal-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />
      <div className="relative max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4">Ready to modernise your accounting?</h2>
        <p className="text-lg text-gray-400 mb-8 max-w-xl mx-auto">
          Join South African businesses who have already made the switch to ISAFlow. Start your 14-day free trial today.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a href={`${APP_URL}/register`} className="inline-flex items-center justify-center gap-2 px-8 py-3.5 text-base font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-500 rounded-xl hover:from-teal-600 hover:to-cyan-600 transition-all shadow-xl shadow-teal-500/25">
            Start Free Trial <ArrowRight className="w-4 h-4" />
          </a>
          <a href="#contact" className="inline-flex items-center justify-center gap-2 px-8 py-3.5 text-base font-semibold text-white border border-gray-600 rounded-xl hover:bg-gray-800 transition-all">
            Contact Sales
          </a>
        </div>
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="bg-gray-950 text-gray-400 py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-12">
          <div>
            <div className="mb-4">
              <img src="/logo.png" alt="ISAFlow" className="h-10 w-auto brightness-0 invert" />
            </div>
            <p className="text-sm leading-relaxed">
              Modern cloud accounting software built specifically for South African businesses. SARS-compliant from day one.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white mb-4">Product</h4>
            <ul className="space-y-2.5 text-sm">
              <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
              <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
              <li><a href={`${APP_URL}/login`} className="hover:text-white transition-colors">Sign In</a></li>
              <li><span className="opacity-50 cursor-default" title="Coming soon">API Documentation</span></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white mb-4">Resources</h4>
            <ul className="space-y-2.5 text-sm">
              <li><a href="#faq" className="hover:text-white transition-colors">FAQ</a></li>
              <li><span className="opacity-50 cursor-default" title="Coming soon">Help Centre</span></li>
              <li><span className="opacity-50 cursor-default" title="Coming soon">Blog</span></li>
              <li><span className="opacity-50 cursor-default" title="Coming soon">SARS Compliance Guide</span></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white mb-4">Company</h4>
            <ul className="space-y-2.5 text-sm">
              <li><span className="opacity-50 cursor-default" title="Coming soon">About</span></li>
              <li><a href="#contact" className="hover:text-white transition-colors">Contact</a></li>
              <li><span className="opacity-50 cursor-default" title="Coming soon">Privacy Policy</span></li>
              <li><span className="opacity-50 cursor-default" title="Coming soon">Terms of Service</span></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-gray-800 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs">&copy; {new Date().getFullYear()} ISAFlow. All rights reserved.</p>
          <div className="flex items-center gap-2 text-xs">
            <Shield className="w-3.5 h-3.5 text-teal-500" />
            <span>SARS Compliant &middot; POPIA Compliant &middot; 256-bit SSL Encryption</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
