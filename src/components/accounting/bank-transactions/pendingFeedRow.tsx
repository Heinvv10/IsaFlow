/**
 * pendingFeedRow — a transaction whose feedState is 'pending' has not yet
 * posted at the bank. It is read-only in the review table: no row action can
 * act on it, and it is excluded from bulk selections.
 */
export function isPendingFeedRow(tx: { feedState?: string }): boolean {
  return tx.feedState === 'pending';
}

export function actionableIds<T extends { id: string; feedState?: string }>(txs: T[], ids: string[]): string[] {
  const pending = new Set(txs.filter(isPendingFeedRow).map((t) => t.id));
  return ids.filter((id) => !pending.has(id));
}

export function PendingFeedBadge(): JSX.Element {
  return (
    <span
      className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      title="The bank has not posted this transaction yet"
    >
      Pending
    </span>
  );
}

export function PendingFeedNotice(): JSX.Element {
  return <span className="text-xs text-gray-500 dark:text-gray-400">Pending at the bank — actions unlock once it posts.</span>;
}
