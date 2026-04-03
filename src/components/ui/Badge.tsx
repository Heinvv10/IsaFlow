/**
 * Badge — status indicator pill used throughout accounting views.
 * WORKING: CVA variants, dot indicator, dark mode support.
 *
 * Usage: <Badge variant="success">Paid</Badge>
 *        <Badge variant="danger" dot>Overdue</Badge>
 */

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/utils/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full font-medium',
  {
    variants: {
      variant: {
        default: [
          'bg-teal-100 text-teal-700',
          'dark:bg-teal-900/40 dark:text-teal-300',
        ],
        success: [
          'bg-green-100 text-green-700',
          'dark:bg-green-900/40 dark:text-green-300',
        ],
        warning: [
          'bg-amber-100 text-amber-700',
          'dark:bg-amber-900/40 dark:text-amber-300',
        ],
        danger: [
          'bg-red-100 text-red-700',
          'dark:bg-red-900/40 dark:text-red-300',
        ],
        info: [
          'bg-blue-100 text-blue-700',
          'dark:bg-blue-900/40 dark:text-blue-300',
        ],
        neutral: [
          'bg-gray-100 text-gray-600',
          'dark:bg-gray-800 dark:text-gray-400',
        ],
      },
      size: {
        sm: 'px-2 py-0.5 text-xs',
        md: 'px-2.5 py-1 text-xs',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
);

const dotColorMap: Record<string, string> = {
  default: 'bg-teal-500 dark:bg-teal-400',
  success: 'bg-green-500 dark:bg-green-400',
  warning: 'bg-amber-500 dark:bg-amber-400',
  danger: 'bg-red-500 dark:bg-red-400',
  info: 'bg-blue-500 dark:bg-blue-400',
  neutral: 'bg-gray-400 dark:bg-gray-500',
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

function Badge({ className, variant = 'default', size, dot = false, children, ...props }: BadgeProps) {
  const dotColor = dotColorMap[variant ?? 'default'];

  return (
    <span
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cn('inline-block rounded-full', size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2', dotColor)}
        />
      )}
      {children}
    </span>
  );
}

Badge.displayName = 'Badge';

export { Badge, badgeVariants };
