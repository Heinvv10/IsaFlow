/**
 * "History" for one record (forensic-controls step 3): every recorded change
 * to it, newest first, with who, how and when, and each field's before and
 * after. Bank account and ID / tax numbers are masked; owner / admin may
 * reveal one change (audited). Without an entityId it is the company-wide
 * feed (the Change history page), where each change names its entity.
 */
import { History, Loader2 } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { isHistoryAdmin, type EntityType } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { EntityChangeItem } from './EntityChangeItem';
import { useEntityChanges } from './useEntityChanges';

interface Props {
  entityType?: EntityType;
  entityId?: string;
}

export function EntityHistoryTimeline({ entityType, entityId }: Props) {
  const { companyRole } = useCompany();
  const { items, loading, error, hasMore, loadMore, replace } = useEntityChanges({ entityType, entityId });
  const feed = !entityId;

  if (error) return <p className="text-sm text-red-500" role="alert">{error}</p>;
  if (!loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-sm text-[var(--ff-text-secondary)]" data-testid="entity-history-empty">
        <History className="h-6 w-6 text-[var(--ff-text-tertiary)]" />
        No changes recorded yet. History is kept from the day change tracking was switched on.
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="entity-history">
      <ul className="space-y-2">
        {items.map((c) => (
          <EntityChangeItem key={c.id} change={c} canReveal={isHistoryAdmin(companyRole ?? undefined)} showEntity={feed} onRevealed={replace} />
        ))}
      </ul>
      {loading && <Loader2 className="h-5 w-5 animate-spin text-[var(--ff-text-tertiary)] mx-auto" aria-label="Loading" />}
      {!loading && hasMore && (
        <button type="button" onClick={loadMore} className="text-sm text-blue-400 hover:text-blue-300">Show older changes</button>
      )}
    </div>
  );
}
