/**
 * The Approvals > Rules tab (R-035 follow-up, PR A): the company's rules, with
 * New rule, Edit (PUT), an activate/deactivate toggle (PUT isActive), Delete,
 * and "Start from recommended rules" while some type in the starter set has no
 * active rule. Every refusal the server sends (a 403 authority refusal, the
 * in-use 400 on delete) is shown verbatim: apiFetch resolves on a 4xx.
 *
 * `actorRole` is the role the rules GET reports — the one the server's guards
 * rank. Without it the forms are not offered (the roles cannot be ranked).
 */
import { useState } from 'react';
import { AlertCircle, Pencil, Plus, Power, Sparkles, Trash2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';
import { STARTER_RULES } from '@/modules/accounting/services/gl/approvalStarterRules';
import { ApprovalRuleForm } from './ApprovalRuleForm';
import { ApprovalStarterPanel } from './ApprovalStarterPanel';
import { docTypeLabel, formatCurrency, type ApprovalRuleRow } from './approvalRuleDisplay';

interface Props {
  rules: ApprovalRuleRow[];
  /** False when the last load of the rules failed: the table says so instead of "no rules". */
  loaded: boolean;
  actorRole: string | null;
  /** Reloads the rules after a write; reports its own failure. */
  onChanged: () => Promise<void>;
}

const TH = 'text-left px-4 py-3 font-medium text-[var(--ff-text-secondary)]';
const BUTTON = 'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium';

export function ApprovalRulesTab({ rules, loaded, actorRole, onChanged }: Props) {
  const [form, setForm] = useState<{ rule?: ApprovalRuleRow } | null>(null);
  const [deleting, setDeleting] = useState<ApprovalRuleRow | null>(null);
  const [starterOpen, setStarterOpen] = useState(false);
  // The rules with a write in flight. Per rule (review round 2): one write's
  // cleanup must not re-enable another rule's buttons while its write runs.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');

  const lacksStarterType = STARTER_RULES.some((t) => !rules.some((r) => r.isActive && r.documentType === t.documentType));

  const write = async (ruleId: string, init: RequestInit, url: string, failure: string) => {
    setBusy((cur) => new Set(cur).add(ruleId));
    setError('');
    try {
      const res = await apiFetch(url, init);
      await assertOk(res, failure);
      await onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, failure));
    } finally {
      setBusy((cur) => { const next = new Set(cur); next.delete(ruleId); return next; });
    }
  };

  const toggle = (rule: ApprovalRuleRow) => write(rule.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rule.id, isActive: !rule.isActive }),
  }, '/api/accounting/approval-rules', 'Could not change the rule - try again');

  // Delete asks first (review round 1): it sits beside the toggle, on a control.
  const remove = (rule: ApprovalRuleRow) => {
    setDeleting(null);
    return write(rule.id, { method: 'DELETE' }, `/api/accounting/approval-rules?id=${rule.id}`, 'Could not delete the rule - try again');
  };

  return (
    <div className="space-y-4">
      {actorRole && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setForm({})} className={`${BUTTON} bg-brand-600 hover:bg-brand-700 text-white`}>
            <Plus className="h-4 w-4" /> New rule
          </button>
          {lacksStarterType && !starterOpen && (
            <button type="button" onClick={() => setStarterOpen(true)}
              className={`${BUTTON} border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)]`}>
              <Sparkles className="h-4 w-4 text-teal-500" /> Start from recommended rules
            </button>
          )}
        </div>
      )}

      {actorRole && starterOpen && (
        <ApprovalStarterPanel actorRole={actorRole} rules={rules} onCreated={onChanged} onClose={() => setStarterOpen(false)} />
      )}

      {error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-500 text-sm">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--ff-bg-secondary)]">
              <th className={TH}>Rule Name</th>
              <th className={TH}>Document Type</th>
              <th className={TH}>Condition</th>
              <th className={TH}>Approver</th>
              <th className={`${TH} text-center`}>Active</th>
              <th className={`${TH} text-center`}>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-primary)]">
            {rules.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-secondary)]">
                {loaded ? 'No approval rules configured' : 'The rules could not be loaded, so they are not shown.'}
              </td></tr>
            ) : rules.map(rule => (
              <tr key={rule.id} className="hover:bg-[var(--ff-bg-hover)]">
                <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{rule.name}</td>
                <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{docTypeLabel(rule.documentType)}</td>
                <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                  {rule.conditionOperator === 'any' ? 'All documents'
                    : `${rule.conditionField} ${rule.conditionOperator === 'greater_equal' ? '≥' : '>'} ${formatCurrency(rule.conditionValue)}`}
                </td>
                <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">{rule.approverRole}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-block w-2 h-2 rounded-full ${rule.isActive ? 'bg-teal-500' : 'bg-gray-400'}`} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-center gap-3">
                    {actorRole && (
                      <button type="button" aria-label={`Edit ${rule.name}`} onClick={() => setForm({ rule })}
                        className="text-[var(--ff-text-secondary)] hover:text-teal-500">
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
                    <button type="button" aria-label={`${rule.isActive ? 'Deactivate' : 'Activate'} ${rule.name}`}
                      title={rule.isActive ? 'Deactivate' : 'Activate'} disabled={busy.has(rule.id)}
                      onClick={() => void toggle(rule)} className="text-[var(--ff-text-secondary)] hover:text-teal-500 disabled:opacity-50">
                      <Power className="h-4 w-4" />
                    </button>
                    <button type="button" aria-label={`Delete ${rule.name}`} disabled={busy.has(rule.id)}
                      onClick={() => setDeleting(rule)} className="text-red-400 hover:text-red-500 disabled:opacity-50">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete approval rule?"
        message={deleting ? `"${deleting.name}" will be deleted. Deactivating it instead keeps its history.` : ''}
        confirmLabel="Delete rule"
        confirmTone="danger"
        onConfirm={() => { if (deleting) void remove(deleting); }}
        onCancel={() => setDeleting(null)}
      />

      {actorRole && form && (
        <ApprovalRuleForm actorRole={actorRole} rule={form.rule} onSaved={onChanged} onClose={() => setForm(null)} />
      )}
    </div>
  );
}
