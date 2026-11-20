/**
 * The connection's settings, one agreement for both companies: settlement mode, cut-over date, interest rate.
 * The card offers it only to a user who can write in BOTH companies (canEditSettings); anyone else sees the summary line.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { Input } from '@/components/ui/Input';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { ConnectionView, SettlementMode } from '@/modules/accounting/services/intercompany/connectionTypes';

interface Props {
  connection: ConnectionView;
  onSaved: (updated: ConnectionView) => void;
  onError: (message: string) => void;
}

const MODE_LABEL: Record<SettlementMode, string> = {
  cash: 'Cash: invoices age in receivables and payables until paid',
  loan: 'Loan: payments between the companies go to the intercompany loan account',
};

/** '' is no interest; otherwise a number from 0 to 100, or undefined (not a number). */
function parseRate(text: string): number | null | undefined {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : undefined;
}

export function PairSettingsForm({ connection, onSaved, onError }: Props) {
  const { settings } = connection;
  const [mode, setMode] = useState<SettlementMode>(settings.settlementMode);
  const [cutover, setCutover] = useState<string | null>(settings.cutoverDate);
  const [cutoverOk, setCutoverOk] = useState(true);
  const [rate, setRate] = useState(settings.interestRatePct == null ? '' : String(settings.interestRatePct));
  const [saving, setSaving] = useState(false);
  const fid = `ic-pair-${connection.id}`;
  const parsedRate = parseRate(rate);

  async function save() {
    if (parsedRate === undefined) { onError('Interest must be a number from 0 to 100, or empty for none.'); return; }
    setSaving(true);
    try {
      const updated = await apiJson(`/api/accounting/intercompany/connections/${connection.id}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ settlementMode: mode, cutoverDate: cutover, interestRatePct: parsedRate }),
      }, 'Could not save the connection settings - try again');
      onSaved(updated);
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not save the connection settings - try again'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-4" aria-label="Connection settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="text-xs text-ink-muted">One agreement for both companies. Saving changes it for {connection.partnerName} too.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${fid}-mode`} className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Settlement</label>
          <select id={`${fid}-mode`} className="ff-input w-full text-sm" value={mode} onChange={(e) => setMode(e.target.value as SettlementMode)}>
            <option value="cash">{MODE_LABEL.cash}</option>
            <option value="loan">{MODE_LABEL.loan}</option>
          </select>
        </div>
        <DateField id={`${fid}-cutover`} label="Cut-over date (documents before it are paired by hand)" value={cutover}
          onChange={(iso, validity) => { setCutover(iso); setCutoverOk(validity.valid); }} />
        <Input id={`${fid}-rate`} label="Interest, % a year (empty for none)" inputMode="decimal" value={rate}
          onChange={(e) => setRate(e.target.value)} error={parsedRate === undefined ? 'A number from 0 to 100' : undefined} />
      </div>
      <button type="submit" disabled={saving || !cutoverOk || parsedRate === undefined}
        className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
        {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Save connection settings
      </button>
    </form>
  );
}
