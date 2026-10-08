/**
 * New / Edit approval rule (R-035 follow-up, PR A). One form for both: a new
 * rule POSTs to /api/accounting/approval-rules, an edit PUTs only the fields the
 * person changed (an unchanged field is not re-asserted, so it cannot trip a
 * guard on its own). The document type is fixed once a rule exists — updateRule
 * never moves a rule to another type.
 *
 * Types are RULE_FORM_DOCUMENT_TYPES (never a legacy type), operators
 * CONDITION_OPERATORS, approver roles those the actor may demand. The server
 * decides: a 4xx message (a 403 authority refusal, the legacy 400) is shown
 * verbatim and the form stays open — apiFetch resolves on a 4xx.
 */
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { demandableApproverRoles } from '@/modules/accounting/services/gl/approvalRank';
import {
  CONDITION_OPERATORS, RULE_FORM_DOCUMENT_TYPES, RULE_NAME_MAX, hasControlCharacter, hasVisibleCharacter,
} from '@/modules/accounting/services/gl/approvalRuleOptions';
import { ApprovalRoleSelect } from './ApprovalRoleSelect';
import { AMOUNT_RANGE, OPERATOR_LABELS, docTypeLabel, parseAmount, type ApprovalRuleRow } from './approvalRuleDisplay';

interface Props {
  actorRole: string;
  /** The rule being edited; absent for a new rule. */
  rule?: ApprovalRuleRow;
  onSaved: () => Promise<void>;
  onClose: () => void;
}

const FIELD = 'w-full px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] text-sm text-[var(--ff-text-primary)] disabled:opacity-60';
const LABEL = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

export function ApprovalRuleForm({ actorRole, rule, onSaved, onClose }: Props) {
  const [name, setName] = useState(rule?.name ?? '');
  const [documentType, setDocumentType] = useState(rule?.documentType ?? RULE_FORM_DOCUMENT_TYPES[0]!);
  const [operator, setOperator] = useState(rule?.conditionOperator ?? 'greater_than');
  const [amount, setAmount] = useState(String(rule?.conditionValue ?? 0));
  const [role, setRole] = useState(rule?.approverRole ?? demandableApproverRoles(actorRole)[0] ?? 'admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const types: readonly string[] = RULE_FORM_DOCUMENT_TYPES;
  const operators: readonly string[] = CONDITION_OPERATORS;

  /** The request body, or a sentence saying what to fix. */
  function buildBody(): Record<string, unknown> | string {
    if (hasControlCharacter(name.trim())) return 'Enter a name without control characters.';
    if (name.trim() === '' || !hasVisibleCharacter(name)) return 'Enter a name for the rule.';
    if (name.trim().length > RULE_NAME_MAX) return `Enter a name of at most ${RULE_NAME_MAX} characters.`;
    const value = operator === 'any' ? 0 : parseAmount(amount);
    if (value === null) return `Enter an amount ${AMOUNT_RANGE}.`;
    if (!rule) {
      return { name: name.trim(), documentType, conditionOperator: operator, conditionValue: value, approverRole: role };
    }
    const changes: Record<string, unknown> = {};
    if (name.trim() !== rule.name) changes.name = name.trim();
    if (operator !== rule.conditionOperator) changes.conditionOperator = operator;
    if (value !== Number(rule.conditionValue)) changes.conditionValue = value;
    if (role !== rule.approverRole) changes.approverRole = role;
    return { id: rule.id, ...changes };
  }

  const save = async () => {
    const body = buildBody();
    if (typeof body === 'string') { setError(body); return; }
    if (rule && Object.keys(body).length === 1) { onClose(); return; } // nothing changed
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/approval-rules', {
        method: rule ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await assertOk(res, 'Could not save the rule - try again');
      await onSaved();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the rule - try again'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={rule ? 'Edit approval rule' : 'New approval rule'} size="md">
      <Modal.Body className="space-y-3">
        <div>
          <label htmlFor="rule-name" className={LABEL}>Rule name</label>
          <input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
        </div>
        <div>
          <label htmlFor="rule-type" className={LABEL}>Document type</label>
          <select id="rule-type" value={documentType} disabled={!!rule} onChange={(e) => setDocumentType(e.target.value)} className={FIELD}>
            {!types.includes(documentType) && <option value={documentType} disabled>{docTypeLabel(documentType)}</option>}
            {types.map((t) => <option key={t} value={t}>{docTypeLabel(t)}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="rule-operator" className={LABEL}>Condition</label>
            <select id="rule-operator" value={operator} onChange={(e) => setOperator(e.target.value)} className={FIELD}>
              {!operators.includes(operator) && <option value={operator} disabled>{operator} (no longer accepted)</option>}
              {operators.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op] ?? op}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="rule-amount" className={LABEL}>Amount (R)</label>
            <input id="rule-amount" type="number" min={0} step="0.01" value={operator === 'any' ? '0' : amount}
              disabled={operator === 'any'} onChange={(e) => setAmount(e.target.value)} className={FIELD} />
          </div>
        </div>
        <div>
          <label htmlFor="rule-role" className={LABEL}>Approver role</label>
          <ApprovalRoleSelect id="rule-role" label="Approver role" actorRole={actorRole} value={role} onChange={setRole} className={FIELD} />
          <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">Only roles at or below your own can be required.</p>
        </div>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
          Cancel
        </button>
        <button type="button" onClick={() => void save()} disabled={busy}
          className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">
          Save rule
        </button>
      </Modal.Footer>
    </Modal>
  );
}
