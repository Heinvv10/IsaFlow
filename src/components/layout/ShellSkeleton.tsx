/**
 * ShellSkeleton — the app shell's frame, drawn while the first session check runs. Its bars have the real shell's
 * heights (shellHeights.ts), so the content area does not move when the header and navs arrive. The spinner, or
 * the auth-outage message (D9), sits inside the content area.
 */
import Image from 'next/image';
import { AuthPendingScreen } from '@/components/layout/AuthPendingScreen';
import { SHELL_HEIGHTS } from '@/components/layout/shellHeights';

interface ShellSkeletonProps {
  navMode: 'top' | 'side';
  collapsed: boolean;
  /** The top nav rows are drawn (top-nav mode, not the admin host). */
  showTopNav: boolean;
  /** The current page has a module nav row under the top nav. */
  hasModuleNav: boolean;
}

const BAR = { background: 'var(--ff-canvas-mid)', borderBottom: '1px solid var(--ff-canvas-border)' };

export function ShellSkeleton({ navMode, collapsed, showTopNav, hasModuleNav }: ShellSkeletonProps) {
  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--ff-canvas-base)' }}>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {navMode === 'side' && (
          <aside
            className={`hidden lg:flex flex-col flex-shrink-0 ${collapsed ? 'w-16' : 'w-64'}`}
            style={{ background: 'var(--ff-canvas-base)', borderRight: '1px solid var(--ff-canvas-border)' }}
          />
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <header data-testid="shell-header" className="flex items-center px-4 gap-3 flex-shrink-0" style={{ ...BAR, height: SHELL_HEIGHTS.header }}>
            <Image src="/logo.png" alt="ISAFlow" width={80} height={32} className="h-8 w-auto hidden sm:block dark:brightness-0 dark:invert" />
          </header>
          {showTopNav && (
            <div data-testid="shell-top-nav" className="hidden lg:block flex-shrink-0 bg-white dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700" style={{ height: SHELL_HEIGHTS.topNav }} />
          )}
          {showTopNav && hasModuleNav && (
            <div data-testid="shell-module-nav" className="hidden lg:block flex-shrink-0" style={{ ...BAR, height: SHELL_HEIGHTS.moduleNav }} />
          )}
          <main aria-busy="true" className="flex-1 overflow-y-auto" style={{ background: 'var(--ff-canvas-gradient)' }}>
            <AuthPendingScreen />
          </main>
        </div>
      </div>
    </div>
  );
}
