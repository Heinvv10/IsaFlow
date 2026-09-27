/**
 * R-035 PR2: the per-document-type "Enforce" switch on the approval-rules tab.
 *
 * Off by default (Hein: opt-in per company and type). On, the type's posting
 * paths refuse a document an active rule governs until it is approved. The
 * switch calls POST /api/accounting/approval-enforcement; switching OFF weakens
 * a control and is refused (403) below the strictest rule's authority, so a
 * refusal is shown and the switch left as it was — apiFetch resolves on a 4xx.
 * The preview is the server's count of unposted documents the switch holds.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface EnforcementData {
  items: { documentType: string }[];
  enforceable: string[];
  preview: Record<string, number>;
}

const LABELS: Record<string, { name: string; noun: string }> = {
  supplier_invoice: { name: 'supplier invoice', noun: 'bill' },
};

export function ApprovalEnforcementPanel() {
  const [data, setData] = useState<EnforcementData | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await apiFetch('/api/accounting/approval-enforcement');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error?.message || 'Could not load approval enforcement');
      return;
    }
    setData(body.data as EnforcementData);
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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || 'Changing approval enforcement failed');
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Changing approval enforcement failed');
    } finally {
      setBusy('');
    }
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
        const count = `${n} unposted ${label.noun}${n === 1 ? '' : 's'}`;
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
          </div>
        );
      })}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
