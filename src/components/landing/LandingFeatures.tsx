import { Check } from 'lucide-react';
import { FEATURE_PILLARS, DETAILED_FEATURES } from './landingData';

export function LandingFeaturesGrid() {
  return (
    <section id="features" className="py-20 lg:py-28 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">
            Features
          </p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4 text-gray-900">
            Everything you need.
            <br />
            Nothing you don&apos;t.
          </h2>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {FEATURE_PILLARS.map((pillar) => (
            <div key={pillar.title} className="group text-center">
              <div className="w-14 h-14 rounded-2xl bg-white dark:bg-gray-900 flex items-center justify-center mx-auto mb-5 group-hover:bg-teal-600 transition-colors duration-300">
                <pillar.icon className="w-6 h-6 text-slate-900 dark:text-white" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{pillar.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{pillar.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function LandingDetailedFeatures() {
  return (
    <section>
      {DETAILED_FEATURES.map((f, i) => (
        <div key={f.title} className={`py-16 lg:py-24 ${i % 2 === 1 ? 'bg-gray-50' : 'bg-white'}`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
              <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                <span className="inline-block px-3 py-1 rounded-full bg-teal-50 text-teal-700 text-xs font-semibold mb-4 tracking-wide">
                  {f.badge}
                </span>
                <h3 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4 text-gray-900">
                  {f.title}
                </h3>
                <p className="text-gray-500 leading-relaxed mb-6">{f.desc}</p>
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
                <div className="relative rounded-2xl overflow-hidden shadow-2xl border border-gray-100 bg-white">
                  <img
                    src={`/landing/${f.imgKey}.png`}
                    alt={f.title}
                    className="w-full"
                    onError={(e) => {
                      const target = e.currentTarget;
                      target.style.display = 'none';
                      const fallback = target.nextElementSibling as HTMLElement | null;
                      if (fallback) fallback.style.display = 'flex';
                    }}
                  />
                  <div
                    className="hidden aspect-[16/10] bg-gradient-to-br from-slate-800 to-gray-900 items-center justify-center"
                    style={{ display: 'none' }}
                  >
                    <p className="text-gray-500 text-sm">{f.title} screenshot</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
