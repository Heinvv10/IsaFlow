/** A failed drill load: the server's words, the wait if it sent one, and Retry. */
import { Button } from '@/components/ui/Button';
import type { DrillFailure } from './useDrillPages';

export function DrillFailureNote({ failure, onRetry }: { failure: DrillFailure; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {failure.message}{failure.retryAfterSecs ? ` Try again in ${failure.retryAfterSecs} seconds.` : ''}
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}
