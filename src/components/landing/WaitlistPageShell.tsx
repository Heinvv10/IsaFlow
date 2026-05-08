import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { BarChart3, BriefcaseBusiness, ShieldCheck, UsersRound } from 'lucide-react';

const capabilities = [
  { label: 'Financial management', icon: BriefcaseBusiness },
  { label: 'Compliance', icon: ShieldCheck },
  { label: 'Reporting', icon: BarChart3 },
  { label: 'Client work', icon: UsersRound },
];

export function WaitlistPageShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-900"
      style={{ fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
    >
      <img
        src="/landing/login-flow-bg.png"
        alt=""
        className="absolute inset-0 z-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 z-[1] bg-[linear-gradient(90deg,rgba(3,12,27,0.54)_0%,rgba(3,12,27,0.24)_50%,rgba(3,12,27,0.04)_100%)]" />
      <div className="absolute inset-0 z-[1] bg-[linear-gradient(180deg,rgba(2,8,23,0.32)_0%,rgba(2,8,23,0.02)_45%,rgba(2,8,23,0.54)_100%)]" />

      <nav className="relative z-10 border-b border-white/10 bg-slate-950/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:h-20 lg:px-8">
          <Link href="/" className="flex items-center">
            <Image
              src="/logo.png"
              alt="ISAFlow"
              width={160}
              height={64}
              className="h-9 w-auto brightness-0 invert sm:h-10"
              priority
            />
          </Link>

          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-teal-950/30 transition-colors hover:bg-teal-500"
          >
            Sign in
          </Link>
        </div>
      </nav>

      <main className="relative z-10 mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 px-4 py-8 sm:px-6 lg:min-h-[calc(100vh-5rem)] lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)] lg:gap-12 lg:px-8 lg:py-10">
        <section className="max-w-2xl text-white">
          <div className="mb-5 h-1 w-16 rounded-full bg-teal-300 shadow-[0_0_22px_rgba(45,212,191,0.45)] sm:mb-7" />
          <h1 className="max-w-xl text-3xl font-extrabold leading-[1.06] tracking-normal text-white drop-shadow-2xl sm:text-5xl lg:text-[3.35rem]">
            Be first in the flow.
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-white/85 drop-shadow-lg sm:mt-6 sm:text-lg sm:leading-7">
            Join the early access list for a calmer way to manage accounting, compliance,
            payroll and client work in one{' '}
            <span className="font-semibold text-teal-200">intelligent platform.</span>
          </p>

          <div className="mt-9 hidden max-w-xl grid-cols-2 gap-3 sm:grid">
            {capabilities.map(({ label, icon: Icon }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-lg border border-white/[0.14] bg-slate-950/[0.18] px-4 py-3 text-sm font-semibold text-white/90 shadow-xl shadow-slate-950/10 backdrop-blur-md"
              >
                <Icon className="h-5 w-5 text-teal-200" strokeWidth={1.8} />
                {label}
              </div>
            ))}
          </div>
        </section>

        {children}
      </main>
    </div>
  );
}
