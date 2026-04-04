/**
 * Time Tracking Page — thin shell
 * Components: TimeEntryModal, TimeFilters, TimeEntriesTable, TimeSummaryTab, BulkActionsBar
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Clock, Plus, X } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { TimeEntryModal } from '@/components/accounting/time-tracking/TimeEntryModal';
import { TimeFilters, SummaryDateFilter } from '@/components/accounting/time-tracking/TimeFilters';
import { TimeEntriesTable } from '@/components/accounting/time-tracking/TimeEntriesTable';
import { TimeSummaryTab } from '@/components/accounting/time-tracking/TimeSummaryTab';
import { BulkActionsBar } from '@/components/accounting/time-tracking/BulkActionsBar';

interface TimeEntry {
  id: string; userId: string; projectName: string | null; taskDescription: string;
  entryDate: string; hours: number; rate: number | null; amount: number | null;
  billable: boolean; invoiced: boolean; customerId: string | null;
  customerName: string | null; notes: string | null; status: string;
}

interface TimeSummary {
  totalHours: number; billableHours: number; nonBillableHours: number; totalValue: number;
  byProject: { projectName: string; hours: number; value: number }[];
  byCustomer: { customerId: string; customerName: string; hours: number; value: number }[];
}

interface Customer { id: string; companyName: string }
type TabId = 'my-time' | 'all-entries' | 'summary';

const todayStr = () => new Date().toISOString().split('T')[0] ?? '';
const BLANK_FORM = { projectName: '', taskDescription: '', entryDate: todayStr(), hours: '', rate: '', billable: true, customerId: '', notes: '' };
const TABS: { id: TabId; label: string }[] = [
  { id: 'my-time', label: 'My Time' },
  { id: 'all-entries', label: 'All Entries' },
  { id: 'summary', label: 'Summary' },
];

export default function TimeTrackingPage() {
  const [tab, setTab] = useState<TabId>('my-time');
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<TimeSummary | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterCustomer, setFilterCustomer] = useState('');
  const [filterBillable, setFilterBillable] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...BLANK_FORM });

  useEffect(() => {
    apiFetch('/api/accounting/customers').then(r => r.json()).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.items || [];
      setCustomers(list.map((c: Record<string, unknown>) => ({ id: String(c.id), companyName: String(c.companyName || c.company_name || '') })));
    }).catch(() => { /* non-critical */ });
  }, []);

  const loadEntries = useCallback(async () => {
    setLoading(true); setError('');
    const params = new URLSearchParams();
    if (tab === 'my-time') params.set('userId', 'me');
    if (filterStatus) params.set('status', filterStatus);
    if (filterProject) params.set('projectName', filterProject);
    if (filterCustomer) params.set('customerId', filterCustomer);
    if (filterBillable) params.set('billable', filterBillable);
    if (filterDateFrom) params.set('dateFrom', filterDateFrom);
    if (filterDateTo) params.set('dateTo', filterDateTo);
    params.set('limit', '100');
    try {
      const res = await apiFetch(`/api/accounting/time-entries?${params}`);
      const json = await res.json();
      const d = json.data || json;
      setEntries(d.entries || []); setTotal(d.total || 0);
    } catch { setError('Failed to load time entries'); }
    setLoading(false);
  }, [tab, filterStatus, filterProject, filterCustomer, filterBillable, filterDateFrom, filterDateTo]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filterDateFrom) params.set('dateFrom', filterDateFrom);
    if (filterDateTo) params.set('dateTo', filterDateTo);
    try {
      const res = await apiFetch(`/api/accounting/time-summary?${params}`);
      const json = await res.json();
      setSummary(json.data || null);
    } catch { setError('Failed to load summary'); }
    setLoading(false);
  }, [filterDateFrom, filterDateTo]);

  useEffect(() => { if (tab === 'summary') loadSummary(); else loadEntries(); }, [tab, loadEntries, loadSummary]);
  useEffect(() => { if (success) { const t = setTimeout(() => setSuccess(''), 3000); return () => clearTimeout(t); } }, [success]);

  const resetForm = () => { setForm({ ...BLANK_FORM }); setEditId(null); };
  const handleFormChange = (field: string, value: string | boolean) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy('save');
    try {
      const body: Record<string, unknown> = {
        projectName: form.projectName || undefined, taskDescription: form.taskDescription,
        entryDate: form.entryDate, hours: Number(form.hours),
        rate: form.rate ? Number(form.rate) : undefined,
        billable: form.billable, customerId: form.customerId || undefined, notes: form.notes || undefined,
      };
      const res = editId
        ? await apiFetch('/api/accounting/time-entries', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editId, ...body }) })
        : await apiFetch('/api/accounting/time-entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setSuccess(editId ? 'Entry updated' : 'Entry created');
      setShowForm(false); resetForm(); await loadEntries();
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed'); }
    finally { setBusy(''); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this time entry?')) return;
    setBusy(id);
    try {
      const res = await apiFetch(`/api/accounting/time-entries?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setSuccess('Entry deleted'); await loadEntries();
    } catch (err) { setError(err instanceof Error ? err.message : 'Delete failed'); }
    finally { setBusy(''); }
  };

  const handleEdit = (entry: TimeEntry) => {
    setForm({
      projectName: entry.projectName || '', taskDescription: entry.taskDescription,
      entryDate: entry.entryDate.split('T')[0] ?? '', hours: String(entry.hours),
      rate: entry.rate != null ? String(entry.rate) : '',
      billable: entry.billable, customerId: entry.customerId || '', notes: entry.notes || '',
    });
    setEditId(entry.id); setShowForm(true);
  };

  const handleBulkAction = async (action: 'submit' | 'approve') => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBusy(action); setError('');
    try {
      const res = await apiFetch('/api/accounting/time-entries-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ids }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setSuccess(`${action === 'submit' ? 'Submitted' : 'Approved'} ${json.data?.count || 0} entries`);
      setSelected(new Set()); await loadEntries();
    } catch (err) { setError(err instanceof Error ? err.message : 'Action failed'); }
    finally { setBusy(''); }
  };

  const toggleSelect = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSelectAll = () => setSelected(selected.size === entries.length ? new Set() : new Set(entries.map(e => e.id)));

  return (
    <AppLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Clock className="w-7 h-7 text-blue-600 dark:text-blue-400" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Time Tracking</h1>
          </div>
          <button onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" /> New Entry
          </button>
        </div>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 p-3 rounded-lg flex items-center justify-between">
            {error} <button onClick={() => setError('')}><X className="w-4 h-4" /></button>
          </div>
        )}
        {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 p-3 rounded-lg">{success}</div>}

        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {TABS.map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setSelected(new Set()); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {tab !== 'summary' && (
          <TimeFilters
            showFilters={showFilters} onToggle={() => setShowFilters(!showFilters)}
            filterStatus={filterStatus} filterProject={filterProject}
            filterCustomer={filterCustomer} filterBillable={filterBillable}
            filterDateFrom={filterDateFrom} filterDateTo={filterDateTo} customers={customers}
            onFilterStatus={setFilterStatus} onFilterProject={setFilterProject}
            onFilterCustomer={setFilterCustomer} onFilterBillable={setFilterBillable}
            onFilterDateFrom={setFilterDateFrom} onFilterDateTo={setFilterDateTo}
          />
        )}
        {tab === 'summary' && (
          <SummaryDateFilter filterDateFrom={filterDateFrom} filterDateTo={filterDateTo} onFilterDateFrom={setFilterDateFrom} onFilterDateTo={setFilterDateTo} />
        )}

        {tab !== 'summary' && (
          <BulkActionsBar count={selected.size} busy={busy} onSubmit={() => void handleBulkAction('submit')} onApprove={() => void handleBulkAction('approve')} />
        )}

        {showForm && (
          <TimeEntryModal form={form} editId={editId} busy={busy} customers={customers}
            onClose={() => { setShowForm(false); resetForm(); }}
            onSubmit={handleSubmitForm}
            onChange={(field, value) => handleFormChange(String(field), value)}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
        ) : tab === 'summary' ? (
          <TimeSummaryTab summary={summary} />
        ) : (
          <TimeEntriesTable entries={entries} total={total} selected={selected} busy={busy}
            onToggleSelect={toggleSelect} onToggleSelectAll={toggleSelectAll}
            onEdit={handleEdit} onDelete={handleDelete}
          />
        )}
      </div>
    </AppLayout>
  );
}
