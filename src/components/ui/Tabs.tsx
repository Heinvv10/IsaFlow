/**
 * Tabs — accessible horizontal tab bar with optional URL sync, count badges,
 * and two visual variants: 'underline' and 'pill'.
 *
 * Usage (controlled, no URL sync):
 *   <Tabs
 *     tabs={[
 *       { id: 'all', label: 'All', count: 42 },
 *       { id: 'draft', label: 'Draft', count: 3, icon: FileText },
 *     ]}
 *     activeTab="all"
 *     onChange={setActiveTab}
 *   />
 *
 * Usage (URL sync via ?tab= query param):
 *   <Tabs tabs={tabs} urlParam="tab" />
 */

import { useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabVariant = 'underline' | 'pill';

export interface TabDefinition {
  id: string;
  label: string;
  /** Optional numeric badge shown next to the label */
  count?: number;
  /** Optional Lucide icon shown before the label */
  icon?: LucideIcon;
  /** Disable this tab */
  disabled?: boolean;
}

interface TabsBaseProps {
  tabs: TabDefinition[];
  variant?: TabVariant;
  className?: string;
  /** ARIA label for the tablist */
  'aria-label'?: string;
}

/** Controlled mode — caller manages activeTab state */
interface TabsControlledProps extends TabsBaseProps {
  activeTab: string;
  onChange: (id: string) => void;
  urlParam?: never;
}

/** URL-sync mode — reads/writes Next.js router query param */
interface TabsUrlProps extends TabsBaseProps {
  urlParam: string;
  activeTab?: string;
  onChange?: (id: string) => void;
}

type TabsProps = TabsControlledProps | TabsUrlProps;

// ---------------------------------------------------------------------------
// Count badge
// ---------------------------------------------------------------------------

function CountBadge({ count, active }: { count: number; active: boolean }) {
  return (
    <span
      className={cn(
        'ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium leading-none tabular-nums',
        active
          ? 'bg-teal-100 text-teal-700 dark:bg-teal-800/40 dark:text-teal-300'
          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
      )}
    >
      {count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

interface TabButtonProps {
  tab: TabDefinition;
  active: boolean;
  variant: TabVariant;
  onClick: () => void;
}

function TabButton({ tab, active, variant, onClick }: TabButtonProps) {
  const Icon = tab.icon;

  const underlineClasses = cn(
    'relative inline-flex items-center gap-1.5 px-1 pb-3 pt-1 text-sm font-medium border-b-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1',
    active
      ? 'border-teal-600 text-teal-600 dark:border-teal-400 dark:text-teal-400'
      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600',
    tab.disabled && 'cursor-not-allowed opacity-50 pointer-events-none'
  );

  const pillClasses = cn(
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
    active
      ? 'bg-teal-600 text-white dark:bg-teal-500'
      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100',
    tab.disabled && 'cursor-not-allowed opacity-50 pointer-events-none'
  );

  return (
    <button
      type="button"
      role="tab"
      id={`tab-${tab.id}`}
      aria-selected={active}
      aria-controls={`panel-${tab.id}`}
      aria-disabled={tab.disabled}
      disabled={tab.disabled}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={variant === 'underline' ? underlineClasses : pillClasses}
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />}
      {tab.label}
      {tab.count !== undefined && <CountBadge count={tab.count} active={active} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

// WORKING: URL sync reads from router.query; shallow push keeps scroll position
export function Tabs(props: TabsProps): ReactNode {
  const router = useRouter();

  // Resolve active tab
  let activeTab: string;
  if ('urlParam' in props && props.urlParam) {
    const fromUrl = router.query[props.urlParam];
    activeTab =
      props.activeTab ??
      (typeof fromUrl === 'string' ? fromUrl : null) ??
      props.tabs[0]?.id ??
      '';
  } else {
    activeTab = (props as TabsControlledProps).activeTab ?? props.tabs[0]?.id ?? '';
  }

  const handleChange = useCallback(
    (id: string) => {
      if ('urlParam' in props && props.urlParam) {
        void router.push(
          { query: { ...router.query, [props.urlParam]: id } },
          undefined,
          { shallow: true }
        );
        props.onChange?.(id);
      } else {
        (props as TabsControlledProps).onChange(id);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, props]
  );

  const { variant = 'underline', className } = props;

  return (
    <div
      role="tablist"
      aria-label={props['aria-label'] ?? 'Tabs'}
      className={cn(
        'flex',
        variant === 'underline'
          ? 'gap-6 border-b border-gray-200 dark:border-gray-700'
          : 'gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-xl w-fit',
        className
      )}
    >
      {props.tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeTab}
          variant={variant}
          onClick={() => handleChange(tab.id)}
        />
      ))}
    </div>
  );
}
