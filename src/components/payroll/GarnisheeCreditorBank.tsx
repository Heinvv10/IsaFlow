/**
 * GarnisheeCreditorBank - the creditor's bank details on one garnishee order (wave 7 GC1): shown masked (account number
 * to its last four, branch code to its last two, holder to its first letter), entered or changed through
 * PUT .../garnishee-orders/[orderId]. A change to details already entered is owner / admin only, and so is the first
 * entry on an order that has ended or that an approved run has deducted (1051's flag): for anyone else the card offers
 * no form and says who can, and the route refuses them anyway (a refusal is shown). The number is never shown in full
 * here and is cleared from the form once sent.
 * Paying the creditor from the salary bank file comes later (GC2).
 */
import { useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { Input, Select } from '@/components/ui';
import { useCompany } from '@/contexts/CompanyContext';
import { isHistoryAdmin } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import type { CreditorBank } from '@/modules/accounting/services/payroll/payrollGarnisheeCreditorBank';

const TYPES = [
  { value: 'cheque', label: 'Cheque / current' }, { value: 'savings', label: 'Savings' }, { value: 'transmission', label: 'Transmission' },
];
const BTN = 'rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const FAILED = 'Could not save the creditor\'s bank details - try again';

interface Draft { bankName: string; branchCode: string; accountNumber: string; accountType: string; accountHolder: string }

export function GarnisheeCreditorBank({ url, orderId, bank, adminOnly, onSaved }: {
  url: string; orderId: string; bank: CreditorBank | null; adminOnly: boolean; onSaved: () => Promise<void>;
}) {
  const { companyRole } = useCompany();
  const mayEdit = isHistoryAdmin(companyRole ?? undefined) || (!bank && !adminOnly);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(`${url}/${orderId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, accountHolder: draft.accountHolder.trim() || null }),
      });
      await assertOk(res, FAILED);
      setDraft(null);
      await onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, FAILED));
    } finally {
      setSaving(false);
    }
  }

  const summary = bank
    ? `Pays into ${bank.bankName} ${bank.accountType} ${bank.accountNumber}, branch ${bank.branchCode}${bank.accountHolder ? `, holder ${bank.accountHolder}` : ''}`
    : 'No creditor bank details yet';

  return (
    <span className="block w-full text-xs text-[var(--ff-text-secondary)]">
      {draft === null ? (
        <span className="flex flex-wrap items-center gap-2">
          <span data-testid={`creditor-bank-${orderId}`}>{summary}</span>
          {!mayEdit && <span>(an owner or admin {bank ? 'changes them' : 'enters them on this order'})</span>}
          {mayEdit && <button type="button" className="text-[var(--ff-brand-eyebrow)] underline"
            onClick={() => { setError(''); setDraft({ bankName: bank?.bankName ?? '', branchCode: '', accountNumber: '', accountType: bank?.accountType ?? 'cheque', accountHolder: '' }); }}>
            {bank ? 'Change bank details' : 'Enter bank details'}
          </button>}
        </span>
      ) : (
        <fieldset className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2" disabled={saving}>
          <legend className="sr-only">Creditor bank details</legend>
          <Input label="Creditor's bank" value={draft.bankName} onChange={(e) => setDraft({ ...draft, bankName: e.target.value })} />
          <Input label="Branch code" inputMode="numeric" value={draft.branchCode} onChange={(e) => setDraft({ ...draft, branchCode: e.target.value })} />
          <Input label="Account number" inputMode="numeric" autoComplete="off" value={draft.accountNumber}
            onChange={(e) => setDraft({ ...draft, accountNumber: e.target.value })} />
          <Select id={`creditor-type-${orderId}`} label="Account type" value={draft.accountType}
            onChange={(v) => setDraft({ ...draft, accountType: v || 'cheque' })} options={TYPES} />
          <Input label="Account holder (optional)" value={draft.accountHolder} onChange={(e) => setDraft({ ...draft, accountHolder: e.target.value })} />
          <span className="flex items-end gap-2">
            <button type="button" onClick={() => void save()} className={BTN}>{saving ? 'Saving…' : 'Save bank details'}</button>
            <button type="button" onClick={() => { setDraft(null); setError(''); }} className="text-sm underline">Cancel</button>
          </span>
        </fieldset>
      )}
      {error && <span role="alert" className="mt-1 block text-sm text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
