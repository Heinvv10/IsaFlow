/**
 * The approve dialog of a bill (budgets P5-2, spec §5) or a purchase order (P5-3, `noun: 'order'`) that meets a
 * budget. Shows the per-slice remaining table; when a line is over:
 * - warn: a reason is required (the server answers 400 BUDGET_REASON_REQUIRED without one);
 * - block: approval is refused (409); an owner or admin may tick Override and give a reason.
 * The server decides again under its locks: the table is a preview. Render it only while open: it reads the
 * company role (`useCompany`) and starts with a blank reason each time it mounts.
 */
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useCompany } from '@/contexts/CompanyContext';
import type { BudgetCheckLine, BudgetPolicy } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { BudgetLinesTable } from './BudgetLinesTable';

export interface BudgetApproveChoice {
  budgetReason?: string;
  budgetOverride?: boolean;
}

interface Props {
  open: boolean;
  policy: BudgetPolicy;
  lines: readonly BudgetCheckLine[];
  error: string;
  busy: boolean;
  onCancel: () => void;
  onApprove: (choice: BudgetApproveChoice) => void;
  /** What the document is called in the dialog's words (default 'bill'). */
  noun?: 'bill' | 'order';
}

const OVERRIDE_ROLES = ['owner', 'admin'];
const REASON_MAX = 2000;

export function BudgetApproveDialog({ open, policy, lines, error, busy, onCancel, onApprove, noun = 'bill' }: Props) {
  const { companyRole } = useCompany();
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false); // mounted only while open: a new dialog starts blank

  const over = lines.filter((l) => l.over).length;
  const mayOverride = OVERRIDE_ROLES.includes(companyRole ?? '');
  const blocked = policy === 'block' && over > 0;
  const needsReason = over > 0 && (policy === 'warn' || override);
  const canApprove = !busy && (!blocked || (mayOverride && override)) && (!needsReason || reason.trim() !== '');
  const label = blocked ? 'Override and approve' : 'Approve';

  return (
    <Modal open={open} onClose={onCancel} title="Approve against the budget" size="xl">
      <Modal.Body className="space-y-4">
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Remaining budget for each slice this {noun} {noun === 'bill' ? 'posts' : 'commits'} to (budget check: <strong>{policy}</strong>).
        </p>
        <BudgetLinesTable lines={lines} documentNoun={noun === 'bill' ? 'This bill' : 'This order'} />
        {over > 0 && (
          <div id="budget-over-note" className="flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-500"
            role={blocked ? 'alert' : 'status'}>
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {over === 1 ? 'One line is' : `${over} lines are`} over budget.{' '}
              {policy === 'warn' && 'Say why it should be approved anyway; the reason goes on the audit log.'}
              {blocked && (mayOverride
                ? 'Approval is refused unless you override the budget with a reason.'
                : 'Approval is refused. Only an owner or admin can override it.')}
            </span>
          </div>
        )}
        {blocked && mayOverride && (
          <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} disabled={busy} />
            Override the budget for this {noun}
          </label>
        )}
        {needsReason && (
          <label className="block text-sm text-[var(--ff-text-primary)]">
            <span className="block mb-1 font-medium">Reason <span className="text-red-500" aria-hidden="true">*</span></span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
              rows={3}
              required
              aria-required="true"
              aria-describedby="budget-over-note"
              disabled={busy}
              className="w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm"
              placeholder={`Why this ${noun} should be approved over budget`}
            />
          </label>
        )}
        {error && <p className="text-sm text-red-500" role="alert">{error}</p>}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-4 py-2 text-sm rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]">
          Cancel
        </button>
        <button
          type="button"
          disabled={!canApprove}
          onClick={() => onApprove({
            ...(needsReason ? { budgetReason: reason.trim() } : {}),
            ...(blocked && override ? { budgetOverride: true } : {}),
          })}
          className="px-4 py-2 text-sm font-semibold rounded-lg text-white bg-success-700 hover:bg-success-800 disabled:opacity-50"
        >
          {busy ? 'Approving…' : label}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
