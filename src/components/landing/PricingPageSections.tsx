import { ArrowRight, Building2, Check, Lock, Sparkles, TrendingDown } from 'lucide-react';
import { APP_URL } from './landingData';
import {
  BUREAU_FIRM_PORTAL_FREE,
  BUREAU_SKUS,
  CLOSE_AGENT_ADDON,
  PRICE_LOCK,
  SAGE_COMPARISON,
} from './pricingData';

// ── Hero ─────────────────────────────────────────────────────────────────────
export function PricingHero() {
  return (
    <section className="relative bg-[#050a0f] text-white pt-32 pb-20 lg:pt-40 lg:pb-28 overflow-hidden">
      {/* ambient teal glow — the only flourish; kept quiet */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(20,184,166,0.18),transparent_70%)]"
      />
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <p className="text-sm font-semibold text-teal-400 tracking-widest uppercase mb-4">Pricing</p>
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.05] mb-6">
          Everything Sage charges<br className="hidden sm:block" /> extra for — included.
        </h1>
        <p className="text-lg lg:text-xl text-white/70 max-w-2xl mx-auto mb-8">
          One platform for your books, VAT and payroll. And a price that won&apos;t
          jump on you — capped at inflation, guaranteed.
        </p>
        <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-teal-500/15 ring-1 ring-teal-400/30 text-teal-300 text-sm font-semibold mb-10">
          <Lock className="w-4 h-4" /> CPI price-lock — your rate won&apos;t jump
        </span>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href={`${APP_URL}/register`}
            className="inline-flex items-center gap-2 px-8 py-4 text-base font-bold text-slate-900 bg-white rounded-xl hover:bg-white/90 transition-all shadow-2xl"
          >
            Start free trial <ArrowRight className="w-4 h-4" />
          </a>
          <a
            href="#pricing"
            className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-white border border-white/25 rounded-xl hover:bg-white/5 transition-all"
          >
            See plans
          </a>
        </div>
      </div>
    </section>
  );
}

// ── Price-lock signature band ────────────────────────────────────────────────
export function PriceLockBand() {
  return (
    <section className="bg-gray-900 text-white py-20 lg:py-24">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col lg:flex-row lg:items-center gap-10 lg:gap-16">
          <div className="lg:w-1/2">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-teal-500/15 ring-1 ring-teal-400/30 mb-6">
              <Lock className="w-6 h-6 text-teal-300" />
            </div>
            <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
              {PRICE_LOCK.headline}
            </h2>
            <p className="text-lg text-white/70 leading-relaxed">{PRICE_LOCK.body}</p>
          </div>
          <ul className="lg:w-1/2 space-y-4">
            {PRICE_LOCK.points.map((point) => (
              <li
                key={point}
                className="flex items-start gap-3 bg-white/5 border border-white/10 rounded-2xl px-5 py-4"
              >
                <Check className="w-5 h-5 mt-0.5 flex-shrink-0 text-teal-400" />
                <span className="text-sm text-white/80 leading-relaxed">{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ── Sage anchor comparison ───────────────────────────────────────────────────
export function SageComparison() {
  return (
    <section className="py-20 lg:py-28 bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">
            The maths
          </p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-900 mb-4">
            Half the price of a real Sage setup
          </h2>
          <p className="text-lg text-gray-500">{SAGE_COMPARISON.note}</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left text-sm font-semibold text-gray-500 py-3 pr-4">Capability</th>
                <th className="text-right text-sm font-semibold text-gray-500 py-3 px-4">Sage</th>
                <th className="text-right text-sm font-semibold text-teal-600 py-3 pl-4">IsaFlow Business</th>
              </tr>
            </thead>
            <tbody>
              {SAGE_COMPARISON.rows.map((row, i) => {
                const isTotal = i === SAGE_COMPARISON.rows.length - 1;
                return (
                  <tr
                    key={row.label}
                    className={isTotal ? 'border-t-2 border-gray-900' : 'border-b border-gray-100'}
                  >
                    <td className={`py-3 pr-4 text-sm ${isTotal ? 'font-bold text-gray-900' : 'text-gray-700'}`}>
                      {row.label}
                    </td>
                    <td className={`py-3 px-4 text-sm text-right ${isTotal ? 'font-bold text-gray-900' : 'text-gray-500'}`}>
                      {row.sage}
                    </td>
                    <td className={`py-3 pl-4 text-sm text-right font-semibold ${isTotal ? 'text-teal-600 text-base' : 'text-teal-600'}`}>
                      {isTotal ? row.isaflow : (
                        <span className="inline-flex items-center gap-1 justify-end">
                          <Check className="w-4 h-4" /> {row.isaflow}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="flex items-center justify-center gap-2 text-sm text-gray-500 mt-6">
          <TrendingDown className="w-4 h-4 text-teal-500" /> Prices ex-VAT. Sage add-on prices amortised monthly.
        </p>
      </div>
    </section>
  );
}

// ── Bureau / practice SKUs ───────────────────────────────────────────────────
export function BureauSection() {
  return (
    <section id="bureau" className="py-20 lg:py-28 bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">
            For accounting firms &amp; bureaus
          </p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-900 mb-4">
            Free for your practice. Pay per active client.
          </h2>
          <p className="text-lg text-gray-500">
            The firm cockpit — portfolio view, bureau rollup and compliance
            calendar — is free. You only pay for the clients you run.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
          {BUREAU_SKUS.map((sku) => (
            <div key={sku.name} className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Building2 className="w-5 h-5 text-teal-500" />
                <h3 className="text-lg font-semibold text-gray-900">{sku.name}</h3>
              </div>
              <p className="text-sm text-gray-500 mb-5">{sku.desc}</p>
              <div className="flex items-baseline gap-1 mb-6">
                <span className="text-3xl font-extrabold text-gray-900">{sku.price}</span>
                <span className="text-sm text-gray-500">{sku.period}</span>
              </div>
              <ul className="space-y-3">
                {sku.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 mt-0.5 flex-shrink-0 text-teal-500" />
                    <span className="text-sm text-gray-600">{feat}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {BUREAU_FIRM_PORTAL_FREE && (
          <p className="text-center text-sm text-gray-500 mt-8">
            An &ldquo;active&rdquo; client is one with at least one posted transaction in the month.
          </p>
        )}
      </div>
    </section>
  );
}

// ── Close Agent add-on ───────────────────────────────────────────────────────
export function CloseAgentAddOn() {
  return (
    <section className="py-20 lg:py-28 bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl bg-gradient-to-br from-gray-900 to-slate-800 text-white p-8 lg:p-12">
          <div className="flex flex-col lg:flex-row lg:items-center gap-8">
            <div className="lg:flex-1">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-500/15 ring-1 ring-teal-400/30 text-teal-300 text-xs font-bold uppercase tracking-wider mb-4">
                <Sparkles className="w-3.5 h-3.5" /> Add-on
              </div>
              <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mb-3">
                {CLOSE_AGENT_ADDON.name}
              </h2>
              <p className="text-white/70 mb-6">{CLOSE_AGENT_ADDON.desc}</p>
              <ul className="space-y-2.5">
                {CLOSE_AGENT_ADDON.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 mt-0.5 flex-shrink-0 text-teal-400" />
                    <span className="text-sm text-white/80">{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="lg:w-56 flex-shrink-0 text-center lg:border-l lg:border-white/10 lg:pl-8">
              <div className="text-4xl font-extrabold">{CLOSE_AGENT_ADDON.price}</div>
              <div className="text-sm text-white/60 mt-1">{CLOSE_AGENT_ADDON.unit}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
