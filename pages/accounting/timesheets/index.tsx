/**
 * Timesheets — Week View
 * Mon–Sun grid, customer filter, inline entry creation via TimeEntryModal,
 * billable/non-billable summary, "Create Invoice from Selected" bulk action.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Clock, Plus, ChevronLeft, ChevronRight, FileText, Loader2, X, Check } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { TimeEntryModal } from '@/components/accounting/time-tracking/TimeEntryModal';

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface TimeEntry {
  id: string; userId: string; projectName: string | null;
  taskDescription: string; entryDate: string; hours: number;
  rate: number | null; billable: boolean; invoiced: boolean;
  customerId: string | null; customerName: string | null; status: string;
}
interface Customer { id: string; name: string; companyName: string }

const BLANK_FORM = {
  projectName: '', taskDescription: '', entryDate: '', hours: '',
  rate: '', billable: true, customerId: '', notes: '',
};

/* ─── Week helpers ───────────────────────────────────────────────────────── */
function getMondayOf(d: Date): Date {
  const day = d.getDay();
  const m = new Date(d);
  m.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  m.setHours(0, 0, 0, 0);
  return m;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(d.getDate() + n); return r;
}
function fmtISO(d: Date): string { return d.toISOString().split('T')[0] ?? ''; }
function fmtWeekRange(mon: Date): string {
  const sun = addDays(mon, 6);
  const o = (d: Date, y = false) => d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', ...(y ? { year: 'numeric' } : {}) });
  return `${o(mon)} – ${o(sun, true)}`;
}
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ─── Page ───────────────────────────────────────────────────────────────── */
export default function TimesheetsPage() {
  const [weekStart, setWeekStart] = useState<Date>(() => getMondayOf(new Date()));
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filterCustomer, setFilterCustomer] = useState('');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM });
  const [formBusy, setFormBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  useEffect(() => {
    void apiFetch('/api/accounting/customers').then(r => r.json()).then((res: unknown) => {
      const d: Record<string, unknown>[] = Array.isArray((res as { data?: unknown }).data)
        ? (res as { data: Record<string, unknown>[] }).data
        : Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
      setCustomers(d.map(c => ({
        id: String(c.id),
        name: String(c.name ?? c.company_name ?? ''),
        companyName: String(c.name ?? c.company_name ?? ''),
      })));
    }).catch(() => { /* non-critical */ });
  }, []);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const from = fmtISO(weekStart);
    const to = fmtISO(addDays(weekStart, 6));
    const p = new URLSearchParams({ dateFrom: from, dateTo: to, limit: '200' });
    if (filterCustomer) p.set('customerId', filterCustomer);
    try {
      const r = await apiFetch(`/api/accounting/time-entries?${p.toString()}`);
      const j = await r.json() as { data?: { entries?: TimeEntry[] } };
      setEntries(j.data?.entries ?? []);
    } catch { showToast('Failed to load entries', false); }
    setLoading(false);
  }, [weekStart, filterCustomer]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function showToast(msg: string, ok: boolean) { setToast({ msg, ok }); }

  const weekDates = DAY_LABELS.map((_, i) => addDays(weekStart, i));
  const byDate = entries.reduce<Record<string, TimeEntry[]>>((acc, e) => {
    const k = String(e.entryDate).split('T')[0] ?? '';
    if (!acc[k]) acc[k] = [];
    acc[k]!.push(e);
    return acc;
  }, {});

  const totalHours    = entries.reduce((s, e) => s + e.hours, 0);
  const billableHours = entries.filter(e => e.billable).reduce((s, e) => s + e.hours, 0);
  const eligibleIds   = entries.filter(e => e.billable && !e.invoiced).map(e => e.id);

  const toggleSelect  = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll     = () => setSelected(selected.size === eligibleIds.length ? new Set() : new Set(eligibleIds));

  const fc = (field: string, val: string | boolean) => setForm(p => ({ ...p, [field]: val }));

  const handleSubmitForm = async (e: React.FormEvent<Element>) => {
    e.preventDefault();
    if (!form.taskDescription.trim() || !form.hours) { showToast('Description and hours required', false); return; }
    setFormBusy(true);
    try {
      const body = {
        taskDescription: form.taskDescription.trim(),
        projectName: form.projectName.trim() || undefined,
        customerId: form.customerId || undefined,
        entryDate: form.entryDate,
        hours: Number(form.hours),
        rate: form.rate ? Number(form.rate) : undefined,
        billable: form.billable,
        notes: form.notes || undefined,
      };
      const res = await apiFetch('/api/accounting/time-entries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json() as { message?: string };
      if (!res.ok) throw new Error(j.message ?? 'Failed');
      showToast('Entry added', true);
      setShowForm(false); setForm({ ...BLANK_FORM }); void loadEntries();
    } catch (err) { showToast(err instanceof Error ? err.message : 'Save failed', false); }
    setFormBusy(false);
  };

  const handleCreateInvoice = async () => {
    const ids = Array.from(selected);
    if (!ids.length) { showToast('Select entries first', false); return; }
    const first = entries.find(e => ids.includes(e.id));
    if (!first?.customerId) { showToast('Selected entries must have a customer', false); return; }
    setInvoiceBusy(true);
    try {
      const res = await apiFetch('/api/accounting/time-entries-invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeEntryIds: ids, customerId: first.customerId, invoiceDate: fmtISO(new Date()) }),
      });
      const j = await res.json() as { data?: { invoiceNumber?: string }; message?: string };
      if (!res.ok) throw new Error(j.message ?? 'Failed');
      showToast(`Invoice ${j.data?.invoiceNumber ?? ''} created`, true);
      setSelected(new Set()); void loadEntries();
    } catch (err) { showToast(err instanceof Error ? err.message : 'Invoice failed', false); }
    setInvoiceBusy(false);
  };

  return (
    <AppLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Clock className="w-7 h-7 text-blue-600 dark:text-blue-400" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Timesheets</h1>
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <button onClick={() => void handleCreateInvoice()} disabled={invoiceBusy}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-60 text-sm">
                {invoiceBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                Create Invoice ({selected.size})
              </button>
            )}
            <button onClick={() => { setForm({ ...BLANK_FORM, entryDate: fmtISO(new Date()) }); setShowForm(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              <Plus className="w-4 h-4" /> Add Entry
            </button>
          </div>
        </div>

        {/* Toast */}
        {toast && (
          <div className={`flex items-center justify-between p-3 rounded-lg text-sm ${toast.ok ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300' : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'}`}>
            <span className="flex items-center gap-2">{toast.ok ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}{toast.msg}</span>
            <button onClick={() => setToast(null)}><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* Week nav + filter */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1">
            <button onClick={() => setWeekStart(d => addDays(d, -7))} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"><ChevronLeft className="w-4 h-4" /></button>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300 min-w-[200px] text-center">{fmtWeekRange(weekStart)}</span>
            <button onClick={() => setWeekStart(d => addDays(d, 7))} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"><ChevronRight className="w-4 h-4" /></button>
            <button onClick={() => setWeekStart(getMondayOf(new Date()))} className="ml-2 text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">Today</button>
          </div>
          <select value={filterCustomer} onChange={e => setFilterCustomer(e.target.value)}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
            <option value="">All Customers</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Total Hours', value: totalHours.toFixed(2), cls: 'text-gray-900 dark:text-white' },
            { label: 'Billable', value: billableHours.toFixed(2), cls: 'text-emerald-600 dark:text-emerald-400' },
            { label: 'Non-Billable', value: (totalHours - billableHours).toFixed(2), cls: 'text-amber-600 dark:text-amber-400' },
          ].map(s => (
            <div key={s.label} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{s.label}</p>
              <p className={`text-2xl font-bold ${s.cls}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Select all */}
        {eligibleIds.length > 0 && (
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-500 dark:text-gray-400">
            <input type="checkbox" checked={selected.size === eligibleIds.length} onChange={toggleAll} className="rounded" />
            Select all billable uninvoiced ({eligibleIds.length})
          </label>
        )}

        {/* Week grid */}
        {loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
        ) : (
          <div className="grid grid-cols-7 gap-2">
            {weekDates.map((date, i) => {
              const iso = fmtISO(date);
              const dayEntries = byDate[iso] ?? [];
              const dayHours = dayEntries.reduce((s, e) => s + e.hours, 0);
              const isToday = iso === fmtISO(new Date());
              return (
                <div key={iso} className={`rounded-xl border p-3 space-y-2 min-h-[140px] ${isToday ? 'border-blue-400 dark:border-blue-500 bg-blue-50/30 dark:bg-blue-900/10' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'}`}>
                  <div className="text-center">
                    <p className={`text-xs font-semibold ${isToday ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>{DAY_LABELS[i]}</p>
                    <p className={`text-sm ${isToday ? 'text-blue-700 dark:text-blue-300 font-bold' : 'text-gray-700 dark:text-gray-300'}`}>
                      {date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}
                    </p>
                    {dayHours > 0 && <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{dayHours.toFixed(1)}h</p>}
                  </div>
                  <div className="space-y-1.5">
                    {dayEntries.map(entry => (
                      <div key={entry.id} className={`rounded-lg p-2 text-xs border ${entry.billable ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20' : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30'}`}>
                        <div className="flex items-start gap-1">
                          {entry.billable && !entry.invoiced && (
                            <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleSelect(entry.id)} className="mt-0.5 rounded flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-800 dark:text-gray-200 truncate" title={entry.taskDescription}>{entry.taskDescription}</p>
                            {entry.customerName && <p className="text-gray-500 dark:text-gray-400 truncate">{entry.customerName}</p>}
                            {entry.projectName && <p className="text-gray-600 dark:text-gray-400 dark:text-gray-500 truncate">{entry.projectName}</p>}
                          </div>
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="font-semibold text-gray-700 dark:text-gray-300">{entry.hours}h</span>
                          <span className={`px-1 rounded text-[10px] ${entry.invoiced ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : entry.billable ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                            {entry.invoiced ? 'invoiced' : entry.billable ? 'billable' : 'non-bill'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => { setForm({ ...BLANK_FORM, entryDate: iso }); setShowForm(true); }}
                    className="w-full text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 py-1">
                    + add
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* TimeEntryModal */}
        {showForm && (
          <TimeEntryModal
            form={form} editId={null} busy={formBusy ? 'save' : ''} customers={customers}
            onClose={() => { setShowForm(false); setForm({ ...BLANK_FORM }); }}
            onSubmit={e => void handleSubmitForm(e)}
            onChange={(field, val) => fc(String(field), val)}
          />
        )}
      </div>
    </AppLayout>
  );
}
