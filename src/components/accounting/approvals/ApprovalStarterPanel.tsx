/**
 * "Start from recommended rules" (R-035 follow-up, PR A; Hein 2026-10-08 §2a.2).
 * Previews STARTER_RULES — the seeded templates mapped onto today's types — with
 * a tick box, an editable amount and an approver role per row, then creates the
 * ticked rows in ONE request (the server creates all of them or none) and shows
 * what was created and what was skipped as already active.
 *
 * A row already active for the company starts unticked (the server would skip
 * it). So does a row whose recommended approver ranks above the actor: its role
 * is shown but cannot be chosen, and the person either picks a role they may
 * require or leaves it — the server's 403 is shown verbatim if they send it.
 */
import { useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { mayDemandRole } from '@/modules/accounting/services/gl/approvalRank';
import { STARTER_RULES } from '@/modules/accounting/services/gl/approvalStarterRules';
import { ApprovalRoleSelect } from './ApprovalRoleSelect';
import { AMOUNT_RANGE, OPERATOR_LABELS, docTypeLabel, parseAmount, type ApprovalRuleRow } from './approvalRuleDisplay';

interface Props {
  actorRole: string;
  rules: ApprovalRuleRow[];
  onCreated: () => Promise<void>;
  onClose: () => void;
}

interface Row { include: boolean; amount: string; role: string }
interface StarterResult { created: ApprovalRuleRow[]; skipped: { documentType: string; name: string }[] }

const CELL = 'px-3 py-2 text-sm text-[var(--ff-text-secondary)]';
const FIELD = 'px-2 py-1 rounded border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] text-sm text-[var(--ff-text-primary)]';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ApprovalStarterPanel({ actorRole, rules, onCreated, onClose }: Props) {
  const isActive = (documentType: string, name: string) =>
    rules.some((r) => r.isActive && r.documentType === documentType && r.name === name);
  const [rows, setRows] = useState<Row[]>(() => STARTER_RULES.map((t) => ({
    include: !isActive(t.documentType, t.name) && mayDemandRole(actorRole, t.approverRole),
    amount: String(t.conditionValue),
    role: t.approverRole,
  })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StarterResult | null>(null);

  const edit = (i: number, change: Partial<Row>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...change } : r)));

  /** The confirmed rows as the API takes them, or a sentence saying what to fix. */
  function picks(): Record<string, unknown>[] | string {
    const out: Record<string, unknown>[] = [];
    for (const [i, t] of STARTER_RULES.entries()) {
      const row = rows[i]!;
      if (!row.include) continue;
      if (t.conditionOperator === 'any') { out.push({ documentType: t.documentType, approverRole: row.role }); continue; }
      const value = parseAmount(row.amount);
      if (value === null) return `Enter an amount for ${docTypeLabel(t.documentType)} ${AMOUNT_RANGE}.`;
      out.push({ documentType: t.documentType, conditionValue: value, approverRole: row.role });
    }
    return out.length > 0 ? out : 'Tick at least one rule to create.';
  }

  const confirm = async () => {
    const chosen = picks();
    if (typeof chosen === 'string') { setError(chosen); return; }
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/approval-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'starter', rules: chosen }),
      });
      await assertOk(res, 'Could not create the recommended rules - try again');
      const body = await res.json();
      setResult(body.data as StarterResult);
      await onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the recommended rules - try again'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Recommended rules" className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-4 space-y-3">
      <div className="text-sm font-medium text-[var(--ff-text-primary)]">Recommended rules</div>
      {result ? (
        <div className="space-y-2 text-sm text-[var(--ff-text-secondary)]">
          <p className="font-medium text-[var(--ff-text-primary)]">Created {plural(result.created.length, 'rule')}</p>
          {result.created.length > 0 && (
            <ul className="list-disc pl-5">
              {result.created.map((r) => <li key={r.id}>{r.name} — {docTypeLabel(r.documentType)}</li>)}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <p>
              Skipped {result.skipped.length} already active: {result.skipped.map((s) => `${s.name} (${docTypeLabel(s.documentType)})`).join(', ')}
            </p>
          )}
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-[var(--ff-border-primary)]">Done</button>
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--ff-text-secondary)]">
            Untick what you do not want, adjust amounts and approvers, then create. Rules already active are skipped.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <tbody className="divide-y divide-[var(--ff-border-primary)]">
                {STARTER_RULES.map((t, i) => {
                  const label = docTypeLabel(t.documentType);
                  const row = rows[i]!;
                  const note = isActive(t.documentType, t.name) ? 'Already active'
                    : !mayDemandRole(actorRole, row.role) ? `Needs the ${row.role} role or above to create` : '';
                  return (
                    <tr key={t.documentType}>
                      <td className={CELL}>
                        <input type="checkbox" aria-label={`Include ${label}: ${t.name}`} checked={row.include}
                          onChange={(e) => edit(i, { include: e.target.checked })} className="h-4 w-4 accent-teal-600" />
                      </td>
                      <td className={CELL}>{label}</td>
                      <td className={`${CELL} text-[var(--ff-text-primary)]`}>{t.name}</td>
                      <td className={CELL}>{OPERATOR_LABELS[t.conditionOperator]}</td>
                      <td className={CELL}>
                        {t.conditionOperator === 'any' ? '—' : (
                          <input type="number" min={0} step="0.01" aria-label={`Amount for ${label}`} value={row.amount}
                            onChange={(e) => edit(i, { amount: e.target.value })} className={`${FIELD} w-32`} />
                        )}
                      </td>
                      <td className={CELL}>
                        <ApprovalRoleSelect label={`Approver for ${label}`} actorRole={actorRole} value={row.role}
                          onChange={(role) => edit(i, { role })} className={FIELD} />
                      </td>
                      <td className={`${CELL} text-xs text-amber-500`}>{note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => void confirm()} disabled={busy}
              className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">
              Create selected rules
            </button>
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-[var(--ff-text-secondary)]">Cancel</button>
          </div>
        </>
      )}
    </section>
  );
}
