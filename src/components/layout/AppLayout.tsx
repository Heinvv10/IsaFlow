/**
 * Standalone AppLayout for the Accounting app.
 * Provides a collapsible sidebar, top header with user info/logout,
 * and a main content area. No FibreFlow module switcher or chat widget.
 */

import { useState, useEffect, ReactNode } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import {
  LayoutDashboard,
  Users,
  Truck,
  Landmark,
  BookOpen,
  BarChart2,
  Settings,
  ChevronLeft,
  ChevronRight,
  Menu,
  LogOut,
  User,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

// ─── Navigation items ─────────────────────────────────────────────────────────

interface NavLink {
  label: string;
  href: string;
  icon: React.ElementType;
  matchPrefix?: string;
}

const NAV_LINKS: NavLink[] = [
  { label: 'Dashboard', href: '/accounting', icon: LayoutDashboard, matchPrefix: '/accounting' },
  { label: 'Customers', href: '/accounting/customers', icon: Users, matchPrefix: '/accounting/customer' },
  { label: 'Suppliers', href: '/accounting/suppliers', icon: Truck, matchPrefix: '/accounting/supplier' },
  { label: 'Banking', href: '/accounting/bank-accounts', icon: Landmark, matchPrefix: '/accounting/bank' },
  { label: 'Accounts', href: '/accounting/chart-of-accounts', icon: BookOpen, matchPrefix: '/accounting/chart' },
  { label: 'Reports', href: '/accounting/reports', icon: BarChart2, matchPrefix: '/accounting/reports' },
  { label: 'Settings', href: '/accounting/settings', icon: Settings, matchPrefix: '/accounting/settings' },
];

const SIDEBAR_COLLAPSED_KEY = 'accounting-sidebar-collapsed';

// ─── Props ────────────────────────────────────────────────────────────────────

interface AppLayoutProps {
  children: ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AppLayout({ children }: AppLayoutProps) {
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  // Mobile sidebar open state
  const [mobileOpen, setMobileOpen] = useState(false);

  // Desktop collapsed state — read from localStorage after hydration
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (saved !== null) {
      setCollapsed(JSON.parse(saved) as boolean);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
    }
  }, [collapsed, hydrated]);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [router.pathname]);

  const isActive = (link: NavLink): boolean => {
    const p = router.pathname;
    if (link.href === '/accounting') {
      // Dashboard is active only on exact /accounting or /accounting/index
      return p === '/accounting' || p === '/accounting/index';
    }
    return link.matchPrefix ? p.startsWith(link.matchPrefix) : p === link.href;
  };

  const userInitials = user
    ? (`${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() || user.email?.[0]?.toUpperCase() || 'U')
    : 'U';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <LoadingSpinner size="lg" className="mx-auto mb-4" />
          <p className="text-gray-400 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  // ─── Sidebar content (shared between mobile + desktop) ──────────────────────

  const SidebarContent = (
    <>
      {/* Logo / App name */}
      <div className={`flex items-center gap-3 px-4 py-4 border-b border-gray-700 ${collapsed ? 'justify-center' : ''}`}>
        <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center flex-shrink-0">
          <BookOpen className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <span className="font-semibold text-emerald-400 text-sm">
            Accounting
          </span>
        )}
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
        {NAV_LINKS.map(link => {
          const active = isActive(link);
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              title={collapsed ? link.label : undefined}
              className={`
                flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                ${active
                  ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                }
                ${collapsed ? 'justify-center' : ''}
              `}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              {!collapsed && <span>{link.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* User area */}
      <div className={`border-t border-gray-700 p-3 ${collapsed ? 'flex flex-col items-center gap-2' : ''}`}>
        {user && !collapsed && (
          <div className="flex items-center gap-2 px-2 py-2 mb-1">
            <div className="w-7 h-7 bg-emerald-700 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-xs text-white font-semibold">{userInitials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white truncate">
                {user.firstName} {user.lastName}
              </p>
              <p className="text-xs text-gray-500 truncate">{user.role}</p>
            </div>
          </div>
        )}
        <button
          onClick={() => void logout()}
          title={collapsed ? 'Log out' : undefined}
          className={`
            flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-gray-400
            hover:text-white hover:bg-gray-700/50 transition-colors
            ${collapsed ? 'justify-center' : ''}
          `}
        >
          <LogOut className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">

      {/* ── Desktop sidebar ─────────────────────────────────────────────────── */}
      <aside
        className={`
          hidden lg:flex flex-col bg-gray-900 border-r border-gray-700
          transition-all duration-300 flex-shrink-0
          ${collapsed ? 'w-16' : 'w-56'}
        `}
      >
        {SidebarContent}

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center justify-center h-10 border-t border-gray-700 text-gray-500 hover:text-white hover:bg-gray-700/50 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed
            ? <ChevronRight className="w-4 h-4" />
            : <ChevronLeft className="w-4 h-4" />
          }
        </button>
      </aside>

      {/* ── Mobile sidebar overlay ──────────────────────────────────────────── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`
          fixed inset-y-0 left-0 z-40 w-56 bg-gray-900 border-r border-gray-700
          flex flex-col lg:hidden transition-transform duration-300
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {SidebarContent}
      </aside>

      {/* ── Main area ───────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Header */}
        <header className="bg-gray-900 border-b border-gray-700 h-14 flex items-center px-4 gap-3 flex-shrink-0">
          {/* Mobile hamburger */}
          <button
            className="lg:hidden text-gray-400 hover:text-white transition-colors"
            onClick={() => setMobileOpen(o => !o)}
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Title */}
          <span className="text-white font-semibold text-sm hidden sm:block">Accounting</span>

          <div className="flex-1" />

          {/* User info chip */}
          {user && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <User className="w-4 h-4" />
              <span className="hidden sm:inline truncate max-w-[160px]">
                {user.firstName} {user.lastName}
              </span>
            </div>
          )}
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto bg-gray-950">
          {children}
        </main>
      </div>
    </div>
  );
}
