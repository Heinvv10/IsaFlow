/** Edit THIS company's side of one connection. The partner's side is never shown or editable here. */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { ConnectionView, NamedRef, SettlementMode, SideOptions } from '@/modules/accounting/services/intercompany/connectionTypes';

interface Props {
  connection: ConnectionView;
  options: SideOptions;
  onSaved: (updated: ConnectionView) => void;
  onError: (message: string) => void;
}

function Pick({ id, label, value, onChange, items, empty }: {
  id: string; label: string; value: string; onChange: (v: string) => void; items: NamedRef[]; empty: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">{label}</label>
      <select id={id} className="ff-input w-full text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{empty}</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
      </select>
    </div>
  );
}

export function SideForm({ connection, options, onSaved, onError }: Props) {
  const side = connection.side;
  const [customerId, setCustomerId] = useState(side?.customerId ?? '');
  const [supplierId, setSupplierId] = useState(side?.supplierId ?? '');
  const [mode, setMode] = useState<SettlementMode>(side?.settlementMode ?? 'cash');
  const [loanAccountId, setLoanAccountId] = useState(side?.loanAccountId ?? '');
  const [expenseAccountId, setExpenseAccountId] = useState(side?.defaultExpenseAccountId ?? '');
  const [autoAccept, setAutoAccept] = useState(side?.autoAccept ?? false);
  const [cutover, setCutover] = useState<string | null>(side?.cutoverDate ?? null);
  const [cutoverOk, setCutoverOk] = useState(true);
  const [saving, setSaving] = useState(false);
  const fid = `ic-${connection.id}`;

  async function save() {
    setSaving(true);
    try {
      const updated = await apiJson(`/api/accounting/intercompany/connections/${connection.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          customerId: customerId || null,
          supplierId: supplierId || null,
          settlementMode: mode,
          loanAccountId: loanAccountId || null,
          defaultExpenseAccountId: expenseAccountId || null,
          ...(connection.kind === 'group' ? { autoAccept } : {}),
          cutoverDate: cutover,
        }),
      }, 'Could not save these settings - try again');
      onSaved(updated);
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not save these settings - try again'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="text-xs text-ink-muted">
        These are your settings only. {connection.partnerName} sets its own side; you never see or change it.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Pick id={`${fid}-customer`} label={`Customer that is ${connection.partnerName} (when you invoice them)`}
          value={customerId} onChange={setCustomerId} items={options.customers} empty="Not linked" />
        <Pick id={`${fid}-supplier`} label={`Supplier that is ${connection.partnerName} (when they invoice you)`}
          value={supplierId} onChange={setSupplierId} items={options.suppliers} empty="Not linked" />
        <div>
          <label htmlFor={`${fid}-mode`} className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Settlement</label>
          <select id={`${fid}-mode`} className="ff-input w-full text-sm" value={mode} onChange={(e) => setMode(e.target.value as SettlementMode)}>
            <option value="cash">Cash: invoices age in receivables and payables until paid</option>
            <option value="loan">Loan: payments between us go to the intercompany loan account</option>
          </select>
        </div>
        {mode === 'loan' && (
          <Pick id={`${fid}-loan`} label="Intercompany loan account" value={loanAccountId} onChange={setLoanAccountId}
            items={options.accounts} empty="Not set" />
        )}
        <Pick id={`${fid}-expense`} label="Default expense account for bills from them" value={expenseAccountId}
          onChange={setExpenseAccountId} items={options.accounts} empty="Not set" />
        <DateField id={`${fid}-cutover`} label="Cut-over date (documents before it are paired by hand)" value={cutover}
          onChange={(iso, validity) => { setCutover(iso); setCutoverOk(validity.valid); }} />
      </div>
      {connection.kind === 'group' && (
        <label className="flex items-start gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" className="mt-1" checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
          <span>
            Accept invoices from {connection.partnerName} automatically
            <span className="block text-xs text-ink-muted">They arrive as drafts and go through your normal approval. Group connections only.</span>
          </span>
        </label>
      )}
      <button type="submit" disabled={saving || !cutoverOk}
        className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
        {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Save my settings
      </button>
    </form>
  );
}
