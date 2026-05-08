import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';

export function WaitlistSuccessCard() {
  return (
    <div className="mx-auto w-full max-w-md lg:-mt-10">
      <div className="relative overflow-hidden rounded-2xl border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.88))] p-8 text-center shadow-[0_24px_70px_rgba(2,8,23,0.34)] backdrop-blur-2xl">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-teal-300/80 via-teal-500 to-cyan-300/70" />
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-teal-500/10">
          <CheckCircle2 className="h-6 w-6 text-teal-600" />
        </div>
        <h2 className="text-2xl font-bold tracking-normal text-slate-950">
          You&apos;re on the list
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Thanks for your interest in ISAFlow. We&apos;re putting the finishing
          touches on the platform and will be in touch closer to launch to get you set up.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-teal-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
