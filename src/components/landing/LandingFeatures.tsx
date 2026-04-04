import { Check, Layers } from 'lucide-react';
import { FEATURES, DETAILED_FEATURES } from './landingData';

export function LandingFeaturesGrid() {
  return (
    <section id="features" className="py-20 lg:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-wide uppercase mb-3">Everything You Need</p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
            One platform. Complete control.
          </h2>
          <p className="text-lg text-gray-600">
            From invoicing to SARS returns, ISAFlow handles every aspect of your South African business accounting.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {FEATURES.map((f) => (
            <div key={f.title} className="group p-6 rounded-2xl border border-gray-100 hover:border-teal-200 hover:shadow-lg hover:shadow-teal-500/5 transition-all duration-300">
              <div className="w-12 h-12 rounded-xl bg-teal-50 flex items-center justify-center mb-4 group-hover:bg-teal-100 transition-colors">
                <f.icon className="w-6 h-6 text-teal-600" />
              </div>
              <h3 className="text-base font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-gray-600 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function LandingDetailedFeatures() {
  return (
    <section className="py-20 lg:py-28 bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="space-y-24 lg:space-y-32">
          {DETAILED_FEATURES.map((f, i) => (
            <div key={f.title} className={`grid lg:grid-cols-2 gap-12 lg:gap-16 items-center ${i % 2 === 1 ? 'lg:flex-row-reverse' : ''}`}>
              <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                <span className="inline-block px-3 py-1 rounded-full bg-teal-50 text-teal-700 text-xs font-semibold mb-4">{f.badge}</span>
                <h3 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4">{f.title}</h3>
                <p className="text-gray-600 leading-relaxed mb-6">{f.desc}</p>
                <ul className="space-y-3">
                  {f.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-3">
                      <Check className="w-5 h-5 text-teal-500 mt-0.5 flex-shrink-0" />
                      <span className="text-sm text-gray-700">{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={i % 2 === 1 ? 'lg:order-1' : ''}>
                <div className="relative rounded-2xl overflow-hidden shadow-xl border border-gray-200/50">
                  <img
                    src={`/landing/${f.imgKey}.png`}
                    alt={f.title}
                    className="w-full"
                    onError={(e) => {
                      const target = e.currentTarget;
                      target.style.display = 'none';
                      const fallback = target.nextElementSibling as HTMLElement;
                      if (fallback) fallback.style.display = 'flex';
                    }}
                  />
                  <div className="hidden aspect-[16/10] bg-gradient-to-br from-slate-800 to-gray-900 items-center justify-center" style={{ display: 'none' }}>
                    <div className="text-center p-8">
                      <Layers className="w-12 h-12 text-teal-400 mx-auto mb-3" />
                      <p className="text-teal-300 font-semibold">{f.title}</p>
                      <p className="text-gray-500 text-xs mt-1">Image placeholder</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
