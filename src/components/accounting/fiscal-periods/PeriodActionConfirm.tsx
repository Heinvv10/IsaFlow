/**
 * Confirmation for a single fiscal period Close or Lock (audit P3.2). Used by
 * the Fiscal Periods tab and the Financial Years page. Lock is permanent.
 */

import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';

export type ConfirmablePeriodAction = 'close' | 'lock';

export interface PendingPeriodAction {
  id: string;
  periodName: string;
  action: ConfirmablePeriodAction;
}

interface Props {
  pending: PendingPeriodAction | null;
  busy: boolean;
  onConfirm: (pending: PendingPeriodAction) => void;
  onCancel: () => void;
}

export const LOCK_WARNING = 'Locking is permanent. A locked period cannot be reopened.';

export function PeriodActionConfirm({ pending, busy, onConfirm, onCancel }: Props) {
  if (!pending) return null;
  const isLock = pending.action === 'lock';
  return (
    <ConfirmDialog
      open
      title={isLock ? `Lock ${pending.periodName}?` : `Close ${pending.periodName}?`}
      message={isLock
        ? LOCK_WARNING
        : 'You can reopen a closed period until it is locked.'}
      confirmLabel={isLock ? 'Lock permanently' : 'Close period'}
      confirmTone={isLock ? 'danger' : 'primary'}
      busy={busy}
      onConfirm={() => onConfirm(pending)}
      onCancel={onCancel}
    />
  );
}
