/**
 * Shared Tailwind class strings for the public auth surfaces (signup, pending
 * confirmation, email verification). Kept in one place so the glass card,
 * inputs and labels stay identical across the three pages.
 */

export const AUTH_CARD_CLASS =
  'relative overflow-hidden rounded-2xl border border-white/70 ' +
  'bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.88))] ' +
  'p-6 shadow-[0_24px_70px_rgba(2,8,23,0.34)] backdrop-blur-2xl sm:p-8';

/** The teal hairline across the top of every auth card. */
export const AUTH_CARD_ACCENT_CLASS =
  'absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-teal-300/80 via-teal-500 to-cyan-300/70';

export const AUTH_INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3 text-sm !text-slate-950 ' +
  'shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent ' +
  'focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50';

export const AUTH_LABEL_CLASS = 'mb-1.5 block text-xs font-semibold text-slate-700';

export const AUTH_ICON_CLASS =
  'pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400';

export const AUTH_PRIMARY_BUTTON_CLASS =
  'flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 py-3 text-sm ' +
  'font-semibold text-white shadow-lg shadow-teal-600/25 transition hover:bg-teal-700 disabled:opacity-60';
