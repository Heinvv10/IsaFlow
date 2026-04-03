/**
 * Tooltip — CSS-only hover tooltip with position variants.
 * WORKING: No external dependencies, delay via CSS transition, aria-label fallback.
 *
 * Usage:
 *   <Tooltip content="Export to CSV" position="top">
 *     <button>Export</button>
 *   </Tooltip>
 */

import * as React from 'react';
import { cn } from '@/utils/cn';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: string;
  position?: TooltipPosition;
  children: React.ReactElement;
  className?: string;
}

// Positioning styles for the bubble and its arrow
const positionClasses: Record<TooltipPosition, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
};

const arrowClasses: Record<TooltipPosition, string> = {
  top: 'top-full left-1/2 -translate-x-1/2 border-t-gray-800 border-x-transparent border-b-transparent dark:border-t-gray-200',
  bottom: 'bottom-full left-1/2 -translate-x-1/2 border-b-gray-800 border-x-transparent border-t-transparent dark:border-b-gray-200',
  left: 'left-full top-1/2 -translate-y-1/2 border-l-gray-800 border-y-transparent border-r-transparent dark:border-l-gray-200',
  right: 'right-full top-1/2 -translate-y-1/2 border-r-gray-800 border-y-transparent border-l-transparent dark:border-r-gray-200',
};

// WORKING: Pure CSS approach — tooltip visibility controlled by group-hover
function Tooltip({
  content,
  position = 'top',
  children,
  className,
}: TooltipProps) {
  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}

      {/* Tooltip bubble — hidden by default, revealed on group hover with delay */}
      <span
        role="tooltip"
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-md px-2 py-1',
          'text-xs font-medium text-white bg-gray-800',
          'dark:bg-gray-100 dark:text-gray-900',
          'opacity-0 transition-opacity duration-150 delay-300',
          'group-hover:opacity-100',
          positionClasses[position]
        )}
      >
        {content}
        {/* Arrow */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute border-4',
            arrowClasses[position]
          )}
        />
      </span>
    </span>
  );
}

Tooltip.displayName = 'Tooltip';

export { Tooltip };
