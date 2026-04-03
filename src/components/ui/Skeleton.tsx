/**
 * Skeleton — loading placeholder shapes with shimmer animation.
 * // WORKING: Uses tailwind shimmer keyframe already defined in tailwind.config.mjs
 */

import { cn } from '@/utils/cn';

type SkeletonVariant = 'text' | 'heading' | 'avatar' | 'card' | 'table-row';

interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: string;
  height?: string;
  count?: number;
  className?: string;
}

interface SkeletonGroupProps {
  children: React.ReactNode;
  className?: string;
}

// Shimmer base — uses the 'shimmer' animation from tailwind config
const SHIMMER_BASE = [
  'animate-shimmer',
  'bg-[length:200%_100%]',
  'bg-gradient-to-r',
  'from-gray-200 via-gray-100 to-gray-200',
  'dark:from-gray-700 dark:via-gray-600 dark:to-gray-700',
  'rounded',
].join(' ');

function SingleSkeleton({
  variant = 'text',
  width,
  height,
  className,
}: Omit<SkeletonProps, 'count'>) {
  if (variant === 'table-row') {
    return (
      <div className={cn('flex gap-4', className)}>
        {[40, 25, 20, 15].map((pct, i) => (
          <div
            key={i}
            aria-hidden="true"
            style={{ width: `${pct}%` }}
            className={cn(SHIMMER_BASE, 'h-4 rounded')}
          />
        ))}
      </div>
    );
  }

  const variantClasses: Record<Exclude<SkeletonVariant, 'table-row'>, string> = {
    text: 'h-4 w-full rounded',
    heading: 'h-7 w-3/4 rounded',
    avatar: 'h-10 w-10 rounded-full',
    card: 'h-32 w-full rounded-lg',
  };

  const resolvedVariant = variant as Exclude<SkeletonVariant, 'table-row'>;

  return (
    <div
      aria-hidden="true"
      style={{ width, height }}
      className={cn(SHIMMER_BASE, variantClasses[resolvedVariant], className)}
    />
  );
}

// WORKING: Skeleton component with multiple variants
export function Skeleton({
  variant = 'text',
  width,
  height,
  count = 1,
  className,
}: SkeletonProps) {
  if (count === 1) {
    return (
      <SingleSkeleton
        variant={variant}
        width={width}
        height={height}
        className={className}
      />
    );
  }

  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <SingleSkeleton
          key={i}
          variant={variant}
          width={width}
          height={height}
          className={className}
        />
      ))}
    </>
  );
}

// WORKING: Skeleton.Group — wraps multiple skeletons with consistent spacing
function SkeletonGroup({ children, className }: SkeletonGroupProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>{children}</div>
  );
}

Skeleton.Group = SkeletonGroup;
