/**
 * One tab of the asset page's fleet panel: the asset's fuel fills or its services (mig 853) — list, add, delete.
 * A record a bank line links to cannot be deleted (the route answers 409; the button says why and stays disabled).
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { notify } from '@/utils/toast';
import {
  addFleetRecord, deleteFleetRecord, loadFuelRecords, loadServiceRecords, type FleetKind, type FleetRecord,
} from './fleetRecordsApi';
import { formatMoney } from '@/lib/money/formatMoney';

interface Props { assetId: string; kind: FleetKind; onChanged?: () => void }

const fmtR = (n: number) => formatMoney(n);
const EMPTY = { date: '', litres: '', description: '', amount: '', odometerKm: '', supplierName: '', notes: '' };
const NOUN: Record<FleetKind, string> = { fuel: 'fuel record', service: 'service record' };

/** The form as the route's body (`FuelRecordBody` / `ServiceRecordBody`); blank optional fields are left out. */
function bodyOf(kind: FleetKind, f: typeof EMPTY): Record<string, unknown> {
  const opt = (v: string) => (v.trim() === '' ? undefined : v.trim());
  const common = {
    amount: Number(f.amount),
    ...(opt(f.odometerKm) ? { odometerKm: Number(f.odometerKm) } : {}),
    ...(opt(f.supplierName) ? { supplierName: opt(f.supplierName) } : {}),
    ...(opt(f.notes) ? { notes: opt(f.notes) } : {}),
  };
  return kind === 'fuel'
    ? { fillDate: f.date, litres: Number(f.litres), ...common }
    : { serviceDate: f.date, description: f.description.trim(), ...common };
}

export function FleetRecordsTab({ assetId, kind, onChanged }: Props) {
  const [rows, setRows] = useState<FleetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ ...EMPTY, date: localISODate() });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setRows(kind === 'fuel' ? await loadFuelRecords(assetId) : await loadServiceRecords(assetId));
    } catch (err) {
      setRows([]);
      setError(apiErrorMessage(err, `Could not load the ${NOUN[kind]}s - try again`));
    } finally { setLoading(false); }
  }, [assetId, kind]);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setSaving(true); setError('');
    try {
      await addFleetRecord(assetId, kind, bodyOf(kind, form));
      notify.success(kind === 'fuel' ? 'Fuel record added' : 'Service record added');
      setForm({ ...EMPTY, date: form.date });
      await load();
      onChanged?.();
    } catch (err) {
      setError(apiErrorMessage(err, `Could not add the ${NOUN[kind]} - try again`));
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    setDeletingId(id); setError('');
    try {
      await deleteFleetRecord(assetId, kind, id);
      notify.success(kind === 'fuel' ? 'Fuel record deleted' : 'Service record deleted');
      await load();
      onChanged?.();
    } catch (err) {
      setError(apiErrorMessage(err, `Could not delete the ${NOUN[kind]} - try again`));
    } finally { setDeletingId(null); }
  };

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const input = 'ff-input w-full text-xs';

  return (
    <div className="space-y-3">
      {error && <div className="text-xs text-red-400 bg-red-500/10 rounded px-3 py-2">{error}</div>}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end">
        <label className="text-xs text-[var(--ff-text-tertiary)]">Date<input type="date" aria-label="Date" className={input} value={form.date} onChange={set('date')} /></label>
        {kind === 'fuel'
          ? <label className="text-xs text-[var(--ff-text-tertiary)]">Litres<input type="number" aria-label="Litres" min="0" step="0.01" className={input} value={form.litres} onChange={set('litres')} /></label>
          : <label className="text-xs text-[var(--ff-text-tertiary)] md:col-span-2">Description<input aria-label="Description" className={input} value={form.description} onChange={set('description')} /></label>}
        <label className="text-xs text-[var(--ff-text-tertiary)]">Amount (ZAR)<input type="number" aria-label="Amount" min="0" step="0.01" className={input} value={form.amount} onChange={set('amount')} /></label>
        <label className="text-xs text-[var(--ff-text-tertiary)]">Odometer (km)<input type="number" aria-label="Odometer" min="0" step="1" className={input} value={form.odometerKm} onChange={set('odometerKm')} /></label>
        <label className="text-xs text-[var(--ff-text-tertiary)]">Supplier<input aria-label="Supplier" className={input} value={form.supplierName} onChange={set('supplierName')} /></label>
        {kind === 'fuel' && <label className="text-xs text-[var(--ff-text-tertiary)]">Notes<input aria-label="Notes" className={input} value={form.notes} onChange={set('notes')} /></label>}
        <button onClick={() => void add()} disabled={saving || !form.date || form.amount === '' || (kind === 'fuel' ? form.litres === '' : !form.description.trim())}
          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
        </button>
      </div>

      {loading ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" /></div>
        : rows.length === 0 ? <p className="text-xs text-[var(--ff-text-tertiary)] py-4 text-center">No {NOUN[kind]}s yet</p>
          : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[var(--ff-text-secondary)] uppercase border-b border-[var(--ff-border-light)]">
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-left">{kind === 'fuel' ? 'Litres' : 'Description'}</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                  <th className="px-2 py-1.5 text-right">Odometer</th>
                  <th className="px-2 py-1.5 text-left">Supplier</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
                    <td className="px-2 py-1.5">{'fillDate' in r ? r.fillDate : r.serviceDate}</td>
                    <td className="px-2 py-1.5">{'litres' in r ? `${r.litres} L` : r.description}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtR(r.amount)}</td>
                    <td className="px-2 py-1.5 text-right">{r.odometerKm ?? '—'}</td>
                    <td className="px-2 py-1.5">{r.supplierName ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => void remove(r.id)} disabled={r.bankLinkCount > 0 || deletingId === r.id}
                        title={r.bankLinkCount > 0 ? 'A bank transaction is linked to this record — unlink it first' : 'Delete'}
                        aria-label="Delete" className="p-1 rounded text-red-400 hover:bg-red-500/10 disabled:opacity-30">
                        {deletingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </div>
  );
}
