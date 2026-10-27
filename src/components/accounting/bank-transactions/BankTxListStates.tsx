/**
 * BankTxListStates: the loading and empty states of the bank transactions
 * list. The page holds a fixed-height container around them so the swap to
 * rows shifts nothing.
 */
import type { BankTxTab } from './BankTxTabs';
import { ListSkeleton } from '@/components/ui/ListSkeleton';

export function BankTxLoading() {
  return <ListSkeleton rows={8} label="Loading transactions" rowClassName="h-10 items-center" />;
}

export function BankTxEmpty({ tab }: { tab: BankTxTab }) {
  return (
    <div data-testid="bank-tx-empty" className="text-center py-12 text-[var(--ff-text-secondary)]">
      No {tab === 'new' ? 'new' : tab === 'excluded' ? 'excluded' : 'reviewed'} transactions for this account
    </div>
  );
}
