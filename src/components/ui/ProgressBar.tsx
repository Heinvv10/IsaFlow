/**
 * ProgressBar — linear progress indicator with label and percentage display.
 * // WORKING: Smooth CSS transition on value change, configurable colors and sizes
 */

import { cn } from '@/utils/cn';

type ProgressColor = 'teal' | 'green' | 'amber' | 'red' | 'blue';
type ProgressSize = 'sm' | 'md' | 'lg';

interface ProgressBarProps {
  value: number;
  label?: string;
  showPercentage?: boolean;
  size?: ProgressSize;
  color?: ProgressColor;
  className?: string;
  id?: string;
}

const SIZE_CLASSES: Record<ProgressSize, string> = {
  sm: 'h-1.5',
  md: 'h-2.5',
  lg: 'h-4',
};

const COLOR_CLASSES: Record<ProgressColor, string> = {
  teal: 'bg-teal-500',
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  blue: 'bg-blue-500',
};

function clampValue(value: number): number {
  return Math.min(100, Math.max(0, value));
}

// WORKING: ProgressBar component
export function ProgressBar({
  value,
  label,
  showPercentage = false,
  size = 'md',
  color = 'teal',
  className,
  id,
}: ProgressBarProps) {
  const clamped = clampValue(value);
  const labelId = id ?? (label ? `progress-label-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);

  return (
    <div className={cn('w-full', className)}>
      {/* Label row */}
      {(label || showPercentage) && (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          {label && (
            <span
              id={labelId}
              className="text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {label}
            </span>
          )}
          {showPercentage && (
            <span
              aria-hidden="true"
              className="text-sm tabular-nums text-gray-500 dark:text-gray-400"
            >
              {Math.round(clamped)}%
            </span>
          )}
        </div>
      )}

      {/* Track */}
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-labelledby={labelId}
        aria-label={label ?? `${Math.round(clamped)}% complete`}
        className={cn(
          'w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700',
          SIZE_CLASSES[size]
        )}
      >
        {/* Fill */}
        <div
          style={{ width: `${clamped}%` }}
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out',
            COLOR_CLASSES[color]
          )}
        />
      </div>
    </div>
  );
}
