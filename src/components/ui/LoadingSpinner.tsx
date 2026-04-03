/**
 * LoadingSpinner — simple Tailwind CSS spinning circle indicator.
 */

import { cn } from '@/utils/cn';

interface LoadingSpinnerProps {
  /** Tailwind size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Additional Tailwind classes (e.g. "mx-auto") */
  className?: string;
}

const SIZE_CLASSES = {
  sm: 'w-4 h-4 border-2',
  md: 'w-6 h-6 border-2',
  lg: 'w-10 h-10 border-4',
} as const;

// WORKING: Pure Tailwind spinner — no external dependencies
export function LoadingSpinner({ size = 'md', className }: LoadingSpinnerProps) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        SIZE_CLASSES[size],
        'rounded-full animate-spin',
        'border-gray-300 border-t-teal-500',
        'dark:border-gray-600 dark:border-t-teal-400',
        className
      )}
    />
  );
}
