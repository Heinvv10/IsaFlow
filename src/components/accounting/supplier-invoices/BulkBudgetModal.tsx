/**
 * The bulk approve modal when selected bills are over budget (budgets P5-2, spec §5): the count
 * over budget and ONE reason for the batch. warn: every bill is approved and the reason is recorded
 * on each over-budget bill's check; block: the over-budget bills are refused (409 per item) and the
 * rest approved (overriding is a single-bill act). Each bill is judged here on its own; the server
 * judges them in order, so bills in one batch drawing on one budget can be refused later in the run.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { BudgetPolicy } from '@/modules/accounting/services/budgets/budgetCheckTypes';

const REASON_MAX = 2000;

interface Props {
  open: boolean;
  total: number;
  overBills: number;
  policy: BudgetPolicy;
  verb: string;
  onCancel: () => void;
  onConfirm: (budgetReason: string | undefined) => void;
}

export function BulkBudgetModal({ open, total, overBills, policy, verb, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const block = policy === 'block';
  return (
    <Modal open={open} onClose={onCancel} title={`${verb} ${total} invoice(s)?`} size="md">
      <Modal.Body className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-500" role="status">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {overBills} of {total} selected {total === 1 ? 'bill is' : 'bills are'} over budget.{' '}
            {block
              ? 'They will be refused and the rest approved. An owner or admin can override a bill on its own page.'
              : 'They will be approved and reported as over budget.'}
          </span>
        </div>
        {!block && (
          <label className="block text-sm text-[var(--ff-text-primary)]">
            <span className="block mb-1 font-medium">Reason for the batch (recorded on each over-budget bill)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
              rows={3}
              className="w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm"
              placeholder="Why these bills should be approved over budget"
            />
          </label>
        )}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]">
          Cancel
        </button>
        <button type="button" onClick={() => onConfirm(reason.trim() === '' ? undefined : reason.trim())}
          className="px-4 py-2 text-sm font-semibold rounded-lg text-white bg-success-700 hover:bg-success-800">
          {verb}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
