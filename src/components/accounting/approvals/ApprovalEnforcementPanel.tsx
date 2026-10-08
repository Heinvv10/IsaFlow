/**
 * R-035 PR2: the per-document-type "Enforce" switch on the approval-rules tab
 * (supplier invoices; both credit-note types since PR3; customer invoices since PR4;
 * supplier payments and payment batches since PR5; manual journals since PR6).
 *
 * Off by default (Hein: opt-in per company and type). On, the type's posting
 * paths refuse a document an active rule governs until it is approved. The
 * switch calls POST /api/accounting/approval-enforcement; switching OFF weakens
 * a control and is refused (403) below the strictest rule's authority, so a
 * refusal is shown and the switch left as it was — apiFetch resolves on a 4xx.
 * The preview is the server's count of unposted documents the switch holds.
 *
 * `activeRuleTypes` (R-035 follow-up, PR A): the types the company has an ACTIVE
 * rule for, from the page's own rules list. A switch whose type has none gates
 * nothing, and says so. Undefined while that list is not known (not loaded, or
 * it failed), so the note never speaks from a list that is not there.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';

interface EnforcementData {
  items: { documentType: string }[];
  enforceable: string[];
  preview: Record<string, number>;
  /** Active rules of the legacy `credit_note` type, which govern neither credit-note type. */
  legacyCreditNoteRules?: number;
  /** Active rules of the legacy `payment` type, which govern neither payment type (PR5). */
  legacyPaymentRules?: number;
  /** Active rules of the legacy `journal_entry` type, which govern no journal (PR6). */
  legacyJournalRules?: number;
}

const CREDIT_NOTE_TYPES = new Set(['customer_credit_note', 'supplier_credit_note']);
const PAYMENT_TYPES = new Set(['supplier_payment', 'payment_batch']);

/** R-035 PR3 review B2 (and PR5): legacy rules look like they govern these documents, and do not. */
function legacyWarning(n: number, kind: string, replacement: string): string {
  return n === 1
    ? `1 legacy ${kind} rule governs nothing — re-create it as a ${replacement} rule`
    : `${n} legacy ${kind} rules govern nothing — re-create them as ${replacement} rules`;
}

const LABELS: Record<string, { name: string; noun: string; pending?: string }> = {
  supplier_invoice: { name: 'supplier invoice', noun: 'bill' },
  customer_credit_note: { name: 'customer credit note', noun: 'customer credit note' },
  supplier_credit_note: { name: 'supplier credit note', noun: 'supplier credit note' },
  customer_invoice: { name: 'customer invoice', noun: 'invoice' },
  supplier_payment: { name: 'supplier payment', noun: 'payment', pending: 'unpaid' },
  payment_batch: { name: 'payment batch', noun: 'batch', pending: 'unpaid' },
  manual_journal: { name: 'manual journal', noun: 'journal', pending: 'draft' },
};

/** The coupled payment types (D1): switching one on switches the other, so its rules gate too. */
const COUPLED: Record<string, { other: string; plural: string }> = {
  supplier_payment: { other: 'payment_batch', plural: 'payment batches' },
  payment_batch: { other: 'supplier_payment', plural: 'supplier payments' },
};

/**
 * The note beside a switch whose type has no active rule, or null. A coupled
 * switch whose partner HAS an active rule does gate something — the partner's
 * documents — so it must say only that, never "nothing".
 */
function noRuleNote(type: string, activeRuleTypes: string[] | undefined): string | null {
  if (!activeRuleTypes || activeRuleTypes.includes(type)) return null;
  const coupled = COUPLED[type];
  if (coupled && activeRuleTypes.includes(coupled.other)) {
    return `No active rule for this type — turning this on gates only ${coupled.plural}.`;
  }
  return 'No active rule for this type — turning this on gates nothing.';
}

export function ApprovalEnforcementPanel({ activeRuleTypes }: { activeRuleTypes?: string[] } = {}) {
  const [data, setData] = useState<EnforcementData | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/approval-enforcement?preview=1');
      await assertOk(res, 'Could not load approval enforcement - try again');
      const body = await res.json();
      setData(body.data as EnforcementData);
    } catch (err) {
      setData(null);
      setError(apiErrorMessage(err, 'Could not load approval enforcement - try again'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (documentType: string, enabled: boolean) => {
    setBusy(documentType);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/approval-enforcement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentType, enabled }),
      });
      await assertOk(res, 'Could not change approval enforcement - try again');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not change approval enforcement - try again'));
      setBusy('');
      return;
    }
    await load(); // reports its own failure; the write already succeeded
    setBusy('');
  };

  if (!data || data.enforceable.length === 0) {
    return error ? <p className="text-sm text-red-500">{error}</p> : null;
  }

  return (
    <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--ff-text-primary)]">
        <ShieldCheck className="h-4 w-4 text-teal-500" /> Enforcement
      </div>
      <p className="text-xs text-[var(--ff-text-secondary)]">
        When on, a document an active rule matches cannot be posted until an eligible approver approves it.
      </p>
      {data.enforceable.map((type) => {
        const label = LABELS[type] ?? { name: type.replace(/_/g, ' '), noun: 'document' };
        const on = data.items.some((i) => i.documentType === type);
        const n = data.preview[type] ?? 0;
        const count = `${n} ${label.pending ?? 'unposted'} ${label.noun}${n === 1 ? '' : (label.noun === 'batch' ? 'es' : 's')}`;
        const warning = CREDIT_NOTE_TYPES.has(type) && (data.legacyCreditNoteRules ?? 0) > 0
          ? legacyWarning(data.legacyCreditNoteRules!, 'credit-note', 'customer/supplier credit-note')
          : PAYMENT_TYPES.has(type) && (data.legacyPaymentRules ?? 0) > 0
            ? legacyWarning(data.legacyPaymentRules!, 'payment', 'supplier payment or payment batch')
            : type === 'manual_journal' && (data.legacyJournalRules ?? 0) > 0
              ? legacyWarning(data.legacyJournalRules!, 'journal-entry', 'manual journal') : null;
        const noRule = noRuleNote(type, activeRuleTypes);
        return (
          <div key={type} className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
              <input
                type="checkbox"
                checked={on}
                disabled={busy === type}
                onChange={(e) => { void toggle(type, e.target.checked); }}
                className="h-4 w-4 accent-teal-600"
              />
              Enforce {label.name} approvals
            </label>
            <span className="text-xs text-[var(--ff-text-secondary)]">
              {on ? `${count} awaiting approval` : `${count} would need approval`}
            </span>
            {PAYMENT_TYPES.has(type) && (
              // Coupled (D1): the server switches both; a batch pays the same bills a payment does.
              <p className="w-full text-xs text-[var(--ff-text-secondary)]">
                Switches together with {type === 'supplier_payment' ? 'payment batch' : 'supplier payment'} approvals —
                a batch is also held by each payment&apos;s own rule.
              </p>
            )}
            {noRule && <p className="w-full text-xs text-amber-500">{noRule}</p>}
            {warning && <p className="w-full text-xs text-amber-500">{warning}</p>}
          </div>
        );
      })}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
