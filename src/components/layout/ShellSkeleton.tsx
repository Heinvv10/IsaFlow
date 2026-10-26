/**
 * ShellSkeleton — the app shell's frame, drawn while the first session check runs. Its bars have the real shell's
 * heights (shellHeights.ts), so the content area does not move when the header and navs arrive. The content
 * placeholder, or the auth-outage message (D9), sits inside the content area.
 *
 * Sidebar or top nav rows: whichever public/shell-init.js recorded on <html> before first paint (the CSS rules are in
 * styles/globals.css). Not React state: the saved mode is only readable in the browser, so state would draw the top
 * rows first and then drop them, an 87px jump for sidebar users. AppLayout renders the impersonation banner above
 * both this and the shell, so it is not remounted between them either.
 */
import Image from 'next/image';
import { AuthPendingScreen } from '@/components/layout/AuthPendingScreen';
import { SHELL_HEIGHTS } from '@/components/layout/shellHeights';

interface ShellSkeletonProps {
  /** The current page has a module nav row under the top nav. */
  hasModuleNav: boolean;
}

const BAR = { background: 'var(--ff-canvas-mid)', borderBottom: '1px solid var(--ff-canvas-border)' };
const PULSE = 'rounded bg-slate-200 dark:bg-white/10';

export function ShellSkeleton({ hasModuleNav }: ShellSkeletonProps) {
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <aside
        data-shell-side=""
        data-testid="shell-side"
        className="hidden lg:flex flex-col flex-shrink-0 w-64 overflow-hidden"
        style={{ background: 'var(--ff-canvas-base)', borderRight: '1px solid var(--ff-canvas-border)' }}
      >
        <div className="h-[69px] border-b border-gray-200 dark:border-gray-700" />
        <div className="animate-pulse space-y-4 p-4">
          {Array.from({ length: 9 }, (_, i) => <div key={i} className={`h-3 ${PULSE}`} style={{ width: `${55 + ((i * 17) % 35)}%` }} />)}
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header data-testid="shell-header" className="flex items-center px-4 gap-3 flex-shrink-0" style={{ ...BAR, height: SHELL_HEIGHTS.header }}>
          <Image src="/logo.png" alt="ISAFlow" width={80} height={32} className="h-8 w-auto hidden sm:block dark:brightness-0 dark:invert" />
        </header>
        <div data-shell-top-nav="" data-testid="shell-top-nav" className="hidden lg:block flex-shrink-0 bg-white dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700" style={{ height: SHELL_HEIGHTS.topNav }} />
        {hasModuleNav && (
          <div data-shell-top-nav="" data-testid="shell-module-nav" className="hidden lg:block flex-shrink-0" style={{ ...BAR, height: SHELL_HEIGHTS.moduleNav }} />
        )}
        <main aria-busy="true" className="flex-1 overflow-y-auto" style={{ background: 'var(--ff-canvas-gradient)' }}>
          <AuthPendingScreen />
        </main>
      </div>
    </div>
  );
}
