/**
 * The app's header bar: hamburger, logo, company switcher, quick create, search, setup guide, settings, nav-mode
 * and density toggles, theme, the user and log out. Below `sm` the toggles live in MobileHeaderMenu.
 */
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
  onToggleMobileNav: () => void;
  onToggleNavMode: () => void;
  onOpenCommandPalette: () => void;
}

const ICON_BUTTON = 'p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors';

export function AppHeader({ navMode, isAdminHost, onToggleMobileNav, onToggleNavMode, onOpenCommandPalette }: AppHeaderProps) {
  const { user, logout } = useAuth();
  const showSidebar = navMode === 'side';

  return (
    <header className="flex items-center px-4 gap-3 flex-shrink-0" style={{ height: SHELL_HEIGHTS.header, background: 'var(--ff-canvas-mid)', borderBottom: '1px solid var(--ff-canvas-border)' }}>
      {/* Mobile hamburger */}
      <button
        className="lg:hidden text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        onClick={onToggleMobileNav}
        aria-label="Open menu"
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
          start so the search box beside it does not jump left when it appears. */}
      {!isAdminHost && <div className="w-8 flex-shrink-0"><SetupGuideButton /></div>}

      {/* Settings cog (hidden on admin subdomain) */}
      {!isAdminHost && <SettingsMenu />}

      {/* Nav mode toggle */}
      <button
        onClick={onToggleNavMode}
        className={`hidden sm:block ${ICON_BUTTON}`}
        title={navMode === 'top' ? 'Switch to sidebar navigation' : 'Switch to top navigation'}
      >
        {navMode === 'top' ? <PanelLeft className="w-4 h-4" /> : <PanelTop className="w-4 h-4" />}
      </button>

      {/* Table density toggle (below sm these live in MobileHeaderMenu) */}
      <div className="hidden sm:block"><TableDensityToggle /></div>

      {/* Theme: Light / Dark / System */}
      <div className="hidden sm:block"><ThemeToggle /></div>

      <MobileHeaderMenu
        name={user ? `${user.firstName} ${user.lastName}` : ''}
        navMode={navMode}
        onToggleNavMode={onToggleNavMode}
        onLogout={showSidebar ? undefined : () => void logout()}
      />

      {/* User info */}
      {user && (
        <div className="hidden sm:flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <User className="w-4 h-4" />
          <span className="hidden sm:inline truncate max-w-[160px]">
            {user.firstName} {user.lastName}
          </span>
        </div>
      )}

      {/* Logout (visible in top-nav mode where sidebar user area is hidden) */}
      {!showSidebar && (
        <button
          onClick={() => void logout()}
          className="hidden sm:block p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
          title="Log out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      )}
    </header>
  );
}
