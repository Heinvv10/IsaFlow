/**
 * SettingsSidebar — vertical grouped navigation for Company Settings.
 * Renders six category groups; active item is highlighted in teal.
 *
 * Desktop (>=md): sticky vertical sidebar, 240 px wide, independently scrollable.
 * Mobile (<md): collapses to a horizontal scroll strip rendered above the content.
 *
 * Usage: place inside a `flex flex-col md:flex-row gap-6` container alongside
 * the content area. On desktop the sidebar stretches to 240 px; on mobile it
 * spans the full width as the scroll strip.
 */

import {
  Building2,
  Settings2,
  Globe,
  Receipt,
  CalendarClock,
  BarChart2,
  FileDigit,
  MessageSquare,
  Mail,
  Palette,
  Users,
  Banknote,
  Layers,
  LayoutList,
  ChevronRight,
} from 'lucide-react';
import type { TabId } from './settingsNav';
import { SETTINGS_NAV } from './settingsNav';

// ── Icon map ───────────────────────────────────────────────────────────────────

const ITEM_ICONS: Record<TabId, React.ReactNode> = {
  details: <Building2 className="h-4 w-4" />,
  general: <Settings2 className="h-4 w-4" />,
  regional: <Globe className="h-4 w-4" />,
  vat: <Receipt className="h-4 w-4" />,
  compliance: <CalendarClock className="h-4 w-4" />,
  aging: <BarChart2 className="h-4 w-4" />,
  documents: <FileDigit className="h-4 w-4" />,
  'doc-messages': <MessageSquare className="h-4 w-4" />,
  'email-templates': <Mail className="h-4 w-4" />,
  branding: <Palette className="h-4 w-4" />,
  'customer-zone': <Users className="h-4 w-4" />,
  netcash: <Banknote className="h-4 w-4" />,
  dimensions: <Layers className="h-4 w-4" />,
  udf: <LayoutList className="h-4 w-4" />,
};

// ── Props ──────────────────────────────────────────────────────────────────────

interface SettingsSidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function SettingsSidebar({ activeTab, onTabChange }: SettingsSidebarProps) {
  return (
    <>
      {/* ── Desktop: sticky vertical sidebar ─────────────────────────────── */}
      <nav
        aria-label="Settings navigation"
        className="hidden md:flex flex-col w-60 shrink-0 sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-y-auto"
      >
        <div className="space-y-5">
          {SETTINGS_NAV.map(group => (
            <div key={group.id}>
              <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--ff-text-secondary)] select-none">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map(item => {
                  const isActive = activeTab === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => onTabChange(item.id)}
                        aria-current={isActive ? 'page' : undefined}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                          isActive
                            ? 'bg-teal-500/10 text-teal-500'
                            : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-surface-secondary)] hover:text-[var(--ff-text-primary)]'
                        }`}
                      >
                        <span className={isActive ? 'text-teal-500' : 'text-[var(--ff-text-secondary)]'}>
                          {ITEM_ICONS[item.id]}
                        </span>
                        <span className="flex-1 truncate">{item.label}</span>
                        {isActive && <ChevronRight className="h-3.5 w-3.5 text-teal-500 shrink-0" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      {/* ── Mobile: horizontal scroll strip ──────────────────────────────── */}
      <nav
        aria-label="Settings navigation"
        className="md:hidden w-full flex gap-1 overflow-x-auto pb-2 border-b border-[var(--ff-border-primary)]"
      >
        {SETTINGS_NAV.flatMap(group =>
          group.items.map(item => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onTabChange(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-teal-500/10 text-teal-500'
                    : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                }`}
              >
                {ITEM_ICONS[item.id]}
                {item.label}
              </button>
            );
          })
        )}
      </nav>
    </>
  );
}
