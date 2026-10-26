/**
 * The app's header bar: hamburger, logo, company switcher, quick create, search, setup guide, settings, nav-mode
 * and density toggles, theme, the user and log out. Below `lg` (where the hamburger drawer carries the nav) the
 * toggles, the user and Log out live in MobileHeaderMenu, so the bar fits at 768 and 1024; the user's name shows
 * from `xl`.
 */
import type { RefObject } from 'react';
import Image from 'next/image';
import { Menu, LogOut, User, PanelLeft, PanelTop, Search } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { MobileHeaderMenu } from '@/components/layout/MobileHeaderMenu';
import { CompanySwitcher } from '@/components/layout/CompanySwitcher';
import { CreateNewMenu } from '@/components/layout/CreateNewMenu';
import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { TableDensityToggle } from '@/components/ui/TableDensityToggle';
import { SetupGuideButton } from '@/components/onboarding/SetupGuideButton';
import { SHELL_HEIGHTS } from '@/components/layout/shellHeights';

interface AppHeaderProps {
  navMode: 'top' | 'side';
  /** On the admin subdomain the accounting-only controls are hidden. */
  isAdminHost: boolean;
  mobileNavOpen: boolean;
  onToggleMobileNav: () => void;
  /** The hamburger, so the drawer can hand focus back to it. */
  menuButtonRef: RefObject<HTMLButtonElement>;
  onToggleNavMode: () => void;
  onOpenCommandPalette: () => void;
}

const ICON_BUTTON = 'p-2 rounded-lg text-ink-muted hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors';

export function AppHeader({ navMode, isAdminHost, mobileNavOpen, onToggleMobileNav, menuButtonRef, onToggleNavMode, onOpenCommandPalette }: AppHeaderProps) {
  const { user, logout } = useAuth();
  const showSidebar = navMode === 'side';

  return (
    <header className="flex items-center px-4 gap-3 flex-shrink-0" style={{ height: SHELL_HEIGHTS.header, background: 'var(--ff-canvas-mid)', borderBottom: '1px solid var(--ff-canvas-border)' }}>
      {/* Mobile hamburger */}
      <button
        ref={menuButtonRef}
        className="lg:hidden text-ink-muted hover:text-ink transition-colors"
        onClick={onToggleMobileNav}
        aria-label="Open menu"
        aria-expanded={mobileNavOpen}
        aria-controls="mobile-drawer"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Logo (in top-nav mode, show logo here; in side mode it's in the sidebar) */}
      <Image src="/logo.png" alt="ISAFlow" width={80} height={32} className="h-8 w-auto hidden sm:block dark:brightness-0 dark:invert" />

      {/* Company switcher (hidden on admin subdomain) */}
      {!isAdminHost && (
        <div data-tour="company-switcher">
          <CompanySwitcher />
        </div>
      )}

      <div className="flex-1" />

      {/* Quick create menu (hidden on admin subdomain) */}
      {!isAdminHost && <CreateNewMenu />}

      {/* Command palette trigger */}
      <button
        data-tour="command-palette"
        onClick={onOpenCommandPalette}
        className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] hover:border-teal-400 hover:text-[var(--ff-text-primary)] transition-colors"
        title="Search (Ctrl+K)"
      >
        <Search className="w-3.5 h-3.5" />
        <span className="text-xs">Search</span>
        <kbd className="ml-1 px-1 py-0.5 text-xs bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] rounded">
          Ctrl+K
        </kbd>
      </button>

      {/* Mobile search icon */}
      <button onClick={onOpenCommandPalette} className={`sm:hidden ${ICON_BUTTON}`} title="Search" aria-label="Open search">
        <Search className="w-4 h-4" />
      </button>

      {/* Setup guide (hidden on admin subdomain). It renders once its progress loads; the slot keeps its 32px from the
          start so the search box beside it does not jump left when it appears. When the guide fails to load the slot
          stays as a blank 32px gap: a gap is the lesser evil next to a header that moves on every page load. */}
      {!isAdminHost && <div className="w-8 flex-shrink-0"><SetupGuideButton /></div>}

      {/* Settings cog (hidden on admin subdomain) */}
      {!isAdminHost && <SettingsMenu />}

      {/* Nav mode toggle */}
      <button
        onClick={onToggleNavMode}
        className={`hidden lg:block ${ICON_BUTTON}`}
        title={navMode === 'top' ? 'Switch to sidebar navigation' : 'Switch to top navigation'}
      >
        {navMode === 'top' ? <PanelLeft className="w-4 h-4" /> : <PanelTop className="w-4 h-4" />}
      </button>

      {/* Table density toggle (below lg these live in MobileHeaderMenu) */}
      <div className="hidden lg:block"><TableDensityToggle /></div>

      {/* Theme: Light / Dark / System */}
      <div className="hidden lg:block"><ThemeToggle /></div>

      <MobileHeaderMenu
        name={user ? `${user.firstName} ${user.lastName}` : ''}
        navMode={navMode}
        onToggleNavMode={onToggleNavMode}
        onLogout={showSidebar ? undefined : () => void logout()}
      />

      {/* User info */}
      {user && (
        <div className="hidden xl:flex items-center gap-2 text-sm text-ink-muted">
          <User className="w-4 h-4" />
          <span className="truncate max-w-[160px]">
            {user.firstName} {user.lastName}
          </span>
        </div>
      )}

      {/* Logout (visible in top-nav mode where sidebar user area is hidden) */}
      {!showSidebar && (
        <button
          onClick={() => void logout()}
          className="hidden lg:block p-2 rounded-lg text-ink-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
          title="Log out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      )}
    </header>
  );
}
