/**
 * Breadcrumb — accessible breadcrumb navigation with responsive collapsing.
 *
 * Usage:
 *   <Breadcrumb
 *     items={[
 *       { label: 'Accounting', href: '/accounting' },
 *       { label: 'Invoices', href: '/accounting/customer-invoices' },
 *       { label: 'INV-0042' },
 *     ]}
 *   />
 */

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { cn } from '@/utils/cn';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BreadcrumbSeparator = 'chevron' | 'slash';

export interface BreadcrumbItem {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  separator?: BreadcrumbSeparator;
  className?: string;
  /** Max items shown before collapsing. 0 = no collapse. Default: 4 */
  maxVisible?: number;
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

function Separator({ type }: { type: BreadcrumbSeparator }) {
  if (type === 'chevron') {
    return (
      <ChevronRight
        aria-hidden="true"
        className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0"
      />
    );
  }
  return (
    <span aria-hidden="true" className="text-gray-400 dark:text-gray-500 select-none">
      /
    </span>
  );
}

// ---------------------------------------------------------------------------
// Item renderers
// ---------------------------------------------------------------------------

function BreadcrumbLink({ item }: { item: BreadcrumbItem }) {
  const base =
    'text-sm text-gray-500 dark:text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors truncate max-w-[10rem]';

  if (item.href) {
    return (
      <Link href={item.href} className={base}>
        {item.label}
      </Link>
    );
  }
  if (item.onClick) {
    return (
      <button type="button" onClick={item.onClick} className={cn(base, 'focus:outline-none')}>
        {item.label}
      </button>
    );
  }
  // No href/onClick — render as plain text (fallback)
  return <span className={base}>{item.label}</span>;
}

function BreadcrumbCurrent({ label }: { label: string }) {
  return (
    <span
      aria-current="page"
      className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate max-w-[12rem]"
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// WORKING: Collapsing handled via local state; no router dependency
export function Breadcrumb({
  items,
  separator = 'chevron',
  className,
  maxVisible = 4,
}: BreadcrumbProps) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) return null;

  const shouldCollapse = maxVisible > 0 && !expanded && items.length > maxVisible;

  // Build visible items: always show first + last, collapse the middle
  let visibleItems: (BreadcrumbItem | null)[] = items;
  if (shouldCollapse) {
    // Show first, ellipsis placeholder, then last (maxVisible - 2) items
    const tail = items.slice(-(maxVisible - 1));
    visibleItems = [items[0] ?? null, null, ...tail];
  }

  const lastIndex = visibleItems.length - 1;

  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center', className)}>
      <ol className="flex items-center flex-wrap gap-1">
        {visibleItems.map((item, idx) => {
          const isLast = idx === lastIndex;

          if (item === null) {
            // Ellipsis
            return (
              <li key="ellipsis" className="flex items-center gap-1">
                <Separator type={separator} />
                <button
                  type="button"
                  aria-label="Show all breadcrumbs"
                  onClick={() => setExpanded(true)}
                  className="p-0.5 rounded text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>
              </li>
            );
          }

          return (
            <li key={`${item.label}-${idx}`} className="flex items-center gap-1">
              {idx > 0 && <Separator type={separator} />}
              {isLast ? (
                <BreadcrumbCurrent label={item.label} />
              ) : (
                <BreadcrumbLink item={item} />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
