/**
 * Confirm before suspending one or more companies, with the reason the admin types (audit 3.7: Suspend fired on
 * one click with a hard-coded reason). Confirm stays disabled until a reason is entered.
 */

import { useId, useState } from 'react';
import { ConfirmModal } from '@/components/admin/ConfirmModal';

interface Props {
  /** What is being suspended: a company name, or "3 companies". Null = closed. */
  target: string | null;
  loading: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function SuspendCompanyDialog({ target, loading, onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState('');
  const id = useId();
  const close = () => { setReason(''); onCancel(); };
  return (
    <ConfirmModal
      open={target !== null}
      title="Suspend"
      message={<>Users of <strong>{target}</strong> lose access until an admin activates it again.</>}
      confirmLabel="Suspend"
      confirmClass="bg-yellow-500 hover:bg-yellow-600"
      loading={loading}
      confirmDisabled={reason.trim() === ''}
      onConfirm={() => { const r = reason.trim(); setReason(''); onConfirm(r); }}
      onCancel={close}
    >
      <label htmlFor={id} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Reason (required)</label>
      <textarea id={id} rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)}
        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500" />
    </ConfirmModal>
  );
}
