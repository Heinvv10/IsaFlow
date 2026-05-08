import { useState, useEffect } from 'react';
import { BarChart3, BriefcaseBusiness, ShieldCheck, UsersRound } from 'lucide-react';
import { getDailyLoginQuote } from '@/lib/auth/loginQuotes';
import type { LoginQuote } from '@/lib/auth/loginQuotes';

const capabilities = [
  { label: 'Financial Management', icon: BriefcaseBusiness },
  { label: 'Compliance', icon: ShieldCheck },
  { label: 'Reporting & Insights', icon: BarChart3 },
  { label: 'Client Collaboration', icon: UsersRound },
];

export function LoginBrandPanel() {
  const [quote, setQuote] = useState<LoginQuote | null>(null);
  useEffect(() => { setQuote(getDailyLoginQuote()); }, []);

  return (
    <section className="max-w-2xl text-white">
      <div className="mb-5 h-1 w-16 rounded-full bg-teal-300 shadow-[0_0_22px_rgba(45,212,191,0.45)] sm:mb-7" />

      <h1 className="max-w-xl text-3xl font-extrabold leading-[1.06] tracking-normal text-white drop-shadow-2xl sm:text-5xl lg:text-[3.35rem]">
        Complete Accounting &amp; Practice Management
      </h1>

      <p className="mt-4 max-w-xl text-sm leading-6 text-white/85 drop-shadow-lg sm:mt-6 sm:text-lg sm:leading-7">
        Financial management, compliance, reporting, payroll and client collaboration in one{' '}
        <span className="font-semibold text-teal-200">intelligent platform.</span>
      </p>

      <div className="mt-9 hidden max-w-2xl grid-cols-2 gap-3 sm:grid sm:grid-cols-4">
        {capabilities.map(({ label, icon: Icon }) => (
          <div
            key={label}
            className="flex min-h-[92px] flex-col items-center justify-center gap-2.5 rounded-lg border border-white/[0.14] bg-slate-950/[0.18] px-3 py-3.5 text-center shadow-xl shadow-slate-950/10 backdrop-blur-md"
          >
            <Icon className="h-6 w-6 text-teal-200" strokeWidth={1.7} />
            <span className="text-[11px] font-semibold leading-4 text-white/90">{label}</span>
          </div>
        ))}
      </div>

      {quote && (
        <figure className="mt-8 hidden max-w-lg border-l-2 border-teal-300/90 py-1 pl-5 sm:block">
          <figcaption className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-teal-100/90">
            Daily perspective
          </figcaption>
          <blockquote className="text-sm font-medium leading-6 text-white/90">
            &ldquo;{quote.text}&rdquo;
          </blockquote>
          <p className="mt-3 text-xs leading-5 text-white/70">
            {quote.author}
            <span className="mx-2 text-white/35">&middot;</span>
            {quote.role}
          </p>
        </figure>
      )}
    </section>
  );
}
