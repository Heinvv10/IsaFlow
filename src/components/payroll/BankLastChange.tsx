import { useEntityChanges } from '@/components/accounting/entity-history/useEntityChanges';
import { agoText } from './employeeCreate/bankDetails';

/** "Changed 2 days ago by Hein": the newest recorded change to this bank-detail row. Mounted only once the row's id is known. */
export function BankLastChange({ detailId }: { detailId: string }) {
  const { items, loading, error } = useEntityChanges({ entityType: 'payroll_bank_detail', entityId: detailId });
  const last = items[0];
  if (error) return <p className="text-xs text-red-500" role="alert">{error}</p>;
  if (loading || !last) return null;
  const who = last.actorName ?? (last.actor.startsWith('db:') ? `Database (${last.actor.slice(3)})` : last.actor);
  return (
    <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="bank-last-change">
      {`Changed ${agoText(last.recordedAt)} by ${who}`}
    </p>
  );
}
