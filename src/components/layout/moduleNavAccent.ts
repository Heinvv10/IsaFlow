/** Accent class tokens for ModuleNav. Full class strings so Tailwind's purge pass retains them. */

// 🟢 WORKING: Full class strings — never use template literals with Tailwind.
export type AccentColor = 'teal' | 'blue' | 'amber' | 'emerald' | 'violet' | 'slate' | 'rose' | 'cyan';

export interface AccentTokens {
  activeBorder: string;
  activeText: string;
  activeLinkBg: string;
  activeSectionText: string;
}

export const ACCENT_CLASSES: Record<AccentColor, AccentTokens> = {
  teal: {
    activeBorder: 'border-teal-500',
    activeText: 'text-teal-400',
    activeLinkBg: 'text-teal-400 bg-teal-500/10',
    activeSectionText: 'text-teal-400',
  },
  blue: {
    activeBorder: 'border-blue-500',
    activeText: 'text-blue-400',
    activeLinkBg: 'text-blue-400 bg-blue-500/10',
    activeSectionText: 'text-blue-400',
  },
  amber: {
    activeBorder: 'border-amber-500',
    activeText: 'text-amber-400',
    activeLinkBg: 'text-amber-400 bg-amber-500/10',
    activeSectionText: 'text-amber-400',
  },
  emerald: {
    activeBorder: 'border-emerald-500',
    activeText: 'text-emerald-400',
    activeLinkBg: 'text-emerald-400 bg-emerald-500/10',
    activeSectionText: 'text-emerald-400',
  },
  violet: {
    activeBorder: 'border-violet-500',
    activeText: 'text-violet-400',
    activeLinkBg: 'text-violet-400 bg-violet-500/10',
    activeSectionText: 'text-violet-400',
  },
  slate: {
    activeBorder: 'border-slate-500',
    activeText: 'text-slate-700 dark:text-slate-400',
    activeLinkBg: 'text-slate-700 dark:text-slate-400 bg-slate-500/10',
    activeSectionText: 'text-slate-700 dark:text-slate-400',
  },
  rose: {
    activeBorder: 'border-rose-500',
    activeText: 'text-rose-400',
    activeLinkBg: 'text-rose-400 bg-rose-500/10',
    activeSectionText: 'text-rose-400',
  },
  cyan: {
    activeBorder: 'border-cyan-500',
    activeText: 'text-cyan-400',
    activeLinkBg: 'text-cyan-400 bg-cyan-500/10',
    activeSectionText: 'text-cyan-400',
  },
};
