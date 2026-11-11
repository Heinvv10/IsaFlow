/**
 * Chrome for the admin console sign-in (admin.isaflow.co.za/login, served by
 * pages/console-sign-in.tsx). The admin console keeps its own session, separate
 * from the app's; this only tells the visitor so, instead of showing the
 * marketing sign-in.
 */

import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

export const APP_HOME_URL = 'https://app.isaflow.co.za/accounting';

export function AdminSignInNav() {
  return (
    <nav className="relative z-10 border-b border-white/10 bg-slate-950/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:h-20 lg:px-8">
        <div className="flex items-center gap-3">
          <Image
            src="/logo.png"
            alt="IsaFlow"
            width={160}
            height={64}
            className="h-9 w-auto brightness-0 invert sm:h-10"
            priority
          />
          <span className="rounded-md border border-white/20 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white/80">
            Admin console
          </span>
        </div>
        <Link
          href={APP_HOME_URL}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to the IsaFlow app
        </Link>
      </div>
    </nav>
  );
}

export function AdminSignInNotice() {
  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-white/15 bg-slate-950/70 p-6 text-white shadow-xl backdrop-blur lg:mx-0">
      <ShieldCheck className="h-8 w-8 text-teal-300" />
      <h1 className="mt-4 text-xl font-bold">IsaFlow admin console</h1>
      <p className="mt-2 text-sm text-white/75">
        This is a separate sign-in from the IsaFlow app. Being signed in to the app does not sign you in here.
      </p>
      <p className="mt-2 text-sm text-white/75">Platform administrators only.</p>
    </div>
  );
}
