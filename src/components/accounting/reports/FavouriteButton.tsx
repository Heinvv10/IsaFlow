/**
 * FavouriteButton — star icon toggle for report favouriting.
 * Filled yellow when starred, outline when not.
 * WORKING: uses useReportFavourites hook, Tooltip from shared UI.
 */

import { Star } from 'lucide-react';
import { Tooltip } from '@/components/ui';
import { useReportFavourites } from '@/hooks/useReportFavourites';
import { cn } from '@/utils/cn';

interface FavouriteButtonProps {
  reportId: string;
  className?: string;
}

export function FavouriteButton({ reportId, className }: FavouriteButtonProps) {
  const { isFavourite, toggleFavourite, loading } = useReportFavourites();
  const starred = isFavourite(reportId);

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    toggleFavourite(reportId);
  }

  return (
    <Tooltip
      content={starred ? 'Remove from favourites' : 'Add to favourites'}
      position="top"
    >
      <button
        type="button"
        aria-label={starred ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={starred}
        disabled={loading}
        onClick={handleClick}
        className={cn(
          'inline-flex items-center justify-center rounded p-1',
          'transition-colors duration-150',
          'hover:bg-yellow-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          className,
        )}
      >
        <Star
          className={cn(
            'h-4 w-4 transition-colors duration-150',
            starred
              ? 'fill-yellow-400 text-yellow-400'
              : 'fill-transparent text-[var(--ff-text-tertiary)] hover:text-yellow-400',
          )}
        />
      </button>
    </Tooltip>
  );
}
