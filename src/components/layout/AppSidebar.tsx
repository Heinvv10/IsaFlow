/**
 * The app's sidebar: the desktop sidebar in sidebar nav mode, and the slide-in drawer behind the hamburger, which
 * every mode has below `lg`. Both carry the logo, the same TABS as the top nav (SidebarNav) and the user area.
 */
import Image from 'next/image';
import { BookOpen, ChevronLeft, ChevronRight, LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { SidebarNav } from '@/components/layout/SidebarNav';

interface AppSidebarProps {
  /** Sidebar nav mode: also draw the desktop sidebar. */
  showSidebar: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

function SidebarContent({ collapsed }: { collapsed: boolean }) {
  const { user, logout } = useAuth();
  const { companyRole } = useCompany();
  const userInitials = user
    ? (`${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || user.email?.[0]?.toUpperCase() || 'U')
    : 'U';

  return (
    <>
      {/* Logo */}
      <div className={`flex items-center px-4 py-4 border-b border-gray-200 dark:border-gray-700 ${collapsed ? 'justify-center' : ''}`}>
        {collapsed ? (
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4 h-4 text-white" />
          </div>
        ) : (
          <Image src="/logo.png" alt="ISAFlow" width={90} height={36} className="h-9 w-auto dark:brightness-0 dark:invert" />
        )}
      </div>

      {/* Nav — uses same TABS config as top nav */}
      <SidebarNav collapsed={collapsed} />

      {/* User area */}
      <div className={`border-t border-gray-200 dark:border-gray-700 p-3 ${collapsed ? 'flex flex-col items-center gap-2' : ''}`}>
        {user && !collapsed && (
          <div className="flex items-center gap-2 px-2 py-2 mb-1">
            <div className="w-7 h-7 bg-brand-700 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-xs text-white font-semibold">{userInitials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-900 dark:text-white truncate">
                {user.firstName} {user.lastName}
              </p>
              {/* Show per-company role only. user.role is the global platform role
                  (usually "viewer") and is not meaningful for normal customers. */}
              {companyRole && (
                <p className="text-xs text-ink-faint truncate capitalize">{companyRole}</p>
              )}
            </div>
          </div>
        )}
        <button
          onClick={() => void logout()}
          title={collapsed ? 'Log out' : undefined}
          className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-ink-muted hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors ${collapsed ? 'justify-center' : ''}`}
        >
          <LogOut className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </>
  );
}

const ASIDE_STYLE = { background: 'var(--ff-canvas-base)', borderRight: '1px solid var(--ff-canvas-border)' };

export function AppSidebar({ showSidebar, collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: AppSidebarProps) {
  return (
    <>
      {/* ── Desktop sidebar (only in side mode) ──────────────────────────── */}
      {showSidebar && (
        <aside
          className={`hidden lg:flex flex-col transition-all duration-300 flex-shrink-0 ${collapsed ? 'w-16' : 'w-64'}`}
          style={ASIDE_STYLE}
        >
          <SidebarContent collapsed={collapsed} />

          {/* Collapse toggle */}
          <button
            onClick={onToggleCollapsed}
            className="flex items-center justify-center h-10 text-ink-muted hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
            style={{ borderTop: '1px solid var(--ff-canvas-border)' }}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed
              ? <ChevronRight className="w-4 h-4" />
              : <ChevronLeft className="w-4 h-4" />
            }
          </button>
        </aside>
      )}

      {/* ── Mobile sidebar overlay (always available for mobile) ──────── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={onCloseMobile}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 flex flex-col lg:hidden transition-transform duration-300 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
        style={ASIDE_STYLE}
      >
        <SidebarContent collapsed={collapsed} />
      </aside>
    </>
  );
}
