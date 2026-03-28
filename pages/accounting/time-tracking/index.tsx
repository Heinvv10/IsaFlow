/**
 * Time Tracking Page
 * Billable hours and project time management
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Clock, Plus, Send, CheckCircle, Filter, X, Trash2,
  Loader2, BarChart3, ChevronDown, ChevronUp,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtHours = (n: number) => n.toFixed(2);

interface TimeEntry {
  id: string;
  userId: string;
  projectName: string | null;
  taskDescription: string;
  entryDate: string;
  hours: number;
  rate: number | null;
  amount: number | null;
  billable: boolean;
  invoiced: boolean;
  customerId: string | null;
  customerName: string | null;
  notes: string | null;
  status: string;
}

interface TimeSummary {
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  totalValue: number;
  byProject: { projectName: string; hours: number; value: number }[];
  byCustomer: { customerId: string; customerName: string; hours: number; value: number }[];
}

interface Customer { id: string; companyName: string }

type TabId = 'my-time' | 'all-entries' | 'summary';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  submitted: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  invoiced: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
};

const todayStr = () => new Date().toISOString().split('T')[0];

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

  // Filters
  const [showFilters, setShowFilters] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterCustomer, setFilterCustomer] = useState('');
  const [filterBillable, setFilterBillable] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    projectName: '',
    taskDescription: '',
    entryDate: todayStr(),
    hours: '',
    rate: '',
    billable: true,
    customerId: '',
    notes: '',
  });

  // Load customers once
  useEffect(() => {
    apiFetch('/api/accounting/customers').then(r => r.json()).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.items || [];
      setCustomers(list.map((c: Record<string, unknown>) => ({
        id: String(c.id),
        companyName: String(c.companyName || c.company_name || ''),
      })));
    }).catch(() => { /* ignore */ });
  }, []);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError('');
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
      setEntries(d.entries || []);
      setTotal(d.total || 0);
    } catch {
      setError('Failed to load time entries');
    }
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
    } catch {
      setError('Failed to load summary');
    }
    setLoading(false);
  }, [filterDateFrom, filterDateTo]);

  useEffect(() => {
    if (tab === 'summary') {
      loadSummary();
    } else {
      loadEntries();
    }
  }, [tab, loadEntries, loadSummary]);

  const resetForm = () => {
    setForm({ projectName: '', taskDescription: '', entryDate: todayStr(), hours: '', rate: '', billable: true, customerId: '', notes: '' });
    setEditId(null);
  };

  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy('save');
    try {
      const body: Record<string, unknown> = {
        projectName: form.projectName || undefined,
        taskDescription: form.taskDescription,
        entryDate: form.entryDate,
        hours: Number(form.hours),
        rate: form.rate ? Number(form.rate) : undefined,
        billable: form.billable,
        customerId: form.customerId || undefined,
        notes: form.notes || undefined,
      };

      let res;
      if (editId) {
        res = await apiFetch('/api/accounting/time-entries', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editId, ...body }),
        });
      } else {
        res = await apiFetch('/api/accounting/time-entries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setSuccess(editId ? 'Entry updated' : 'Entry created');
      setShowForm(false);
      resetForm();
      await loadEntries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally { setBusy(''); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this time entry?')) return;
    setBusy(id);
    try {
      const res = await apiFetch(`/api/accounting/time-entries?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setSuccess('Entry deleted');
      await loadEntries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally { setBusy(''); }
  };

  const handleEdit = (entry: TimeEntry) => {
    setForm({
      projectName: entry.projectName || '',
      taskDescription: entry.taskDescription,
      entryDate: entry.entryDate.split('T')[0],
      hours: String(entry.hours),
      rate: entry.rate != null ? String(entry.rate) : '',
      billable: entry.billable,
      customerId: entry.customerId || '',
      notes: entry.notes || '',
    });
    setEditId(entry.id);
    setShowForm(true);
  };

  const handleBulkAction = async (action: 'submit' | 'approve') => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBusy(action); setError('');
    try {
      const res = await apiFetch('/api/accounting/time-entries-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ids }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      const count = json.data?.count || 0;
      setSuccess(`${action === 'submit' ? 'Submitted' : 'Approved'} ${count} entries`);
      setSelected(new Set());
      await loadEntries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally { setBusy(''); }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === entries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(entries.map(e => e.id)));
    }
  };

  // Clear messages after a delay
  useEffect(() => {
    if (success) { const t = setTimeout(() => setSuccess(''), 3000); return () => clearTimeout(t); }
  }, [success]);

  const TABS: { id: TabId; label: string }[] = [
    { id: 'my-time', label: 'My Time' },
    { id: 'all-entries', label: 'All Entries' },
    { id: 'summary', label: 'Summary' },
  ];

  return (
    <AppLayout>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Clock className="w-7 h-7 text-blue-600 dark:text-blue-400" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Time Tracking</h1>
          </div>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" /> New Entry
          </button>
        </div>

        {/* Alerts */}
        {error && (
          <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 p-3 rounded-lg flex items-center justify-between">
            {error}
            <button onClick={() => setError('')}><X className="w-4 h-4" /></button>
          </div>
        )}
        {success && (
          <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 p-3 rounded-lg">
            {success}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setSelected(new Set()); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Filters */}
        {tab !== 'summary' && (
          <div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
            >
              <Filter className="w-4 h-4" />
              Filters
              {showFilters ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {showFilters && (
              <div className="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white">
                  <option value="">All Statuses</option>
                  <option value="draft">Draft</option>
                  <option value="submitted">Submitted</option>
                  <option value="approved">Approved</option>
                  <option value="invoiced">Invoiced</option>
                </select>
                <input value={filterProject} onChange={e => setFilterProject(e.target.value)}
                  placeholder="Project name..." className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
                <select value={filterCustomer} onChange={e => setFilterCustomer(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white">
                  <option value="">All Customers</option>
                  {customers.map(c => <option key={c.id} value={c.id}>{c.companyName}</option>)}
                </select>
                <select value={filterBillable} onChange={e => setFilterBillable(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white">
                  <option value="">All</option>
                  <option value="true">Billable</option>
                  <option value="false">Non-Billable</option>
                </select>
                <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
                <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
              </div>
            )}
          </div>
        )}

        {/* Summary tab filters (date range only) */}
        {tab === 'summary' && (
          <div className="flex gap-3 items-center">
            <Filter className="w-4 h-4 text-gray-500" />
            <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
            <span className="text-gray-500">to</span>
            <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
          </div>
        )}

        {/* Bulk Actions */}
        {tab !== 'summary' && selected.size > 0 && (
          <div className="flex items-center gap-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
              {selected.size} selected
            </span>
            <button
              onClick={() => handleBulkAction('submit')}
              disabled={busy === 'submit'}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {busy === 'submit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Submit
            </button>
            <button
              onClick={() => handleBulkAction('approve')}
              disabled={busy === 'approve'}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Approve
            </button>
          </div>
        )}

        {/* Entry Form Modal */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {editId ? 'Edit Time Entry' : 'New Time Entry'}
                </h2>
                <button onClick={() => { setShowForm(false); resetForm(); }}>
                  <X className="w-5 h-5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300" />
                </button>
              </div>
              <form onSubmit={handleSubmitForm} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
                    <input type="date" required value={form.entryDate}
                      onChange={e => setForm({ ...form, entryDate: e.target.value })}
                      className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project</label>
                    <input value={form.projectName}
                      onChange={e => setForm({ ...form, projectName: e.target.value })}
                      placeholder="Project name"
                      className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Task Description *</label>
                  <input required value={form.taskDescription}
                    onChange={e => setForm({ ...form, taskDescription: e.target.value })}
                    placeholder="What did you work on?"
                    className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Hours *</label>
                    <input type="number" step="0.25" min="0.25" required value={form.hours}
                      onChange={e => setForm({ ...form, hours: e.target.value })}
                      placeholder="0.00"
                      className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Rate (ZAR/hr)</label>
                    <input type="number" step="0.01" min="0" value={form.rate}
                      onChange={e => setForm({ ...form, rate: e.target.value })}
                      placeholder="0.00"
                      className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Customer</label>
                  <select value={form.customerId}
                    onChange={e => setForm({ ...form, customerId: e.target.value })}
                    className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                    <option value="">-- No Customer --</option>
                    {customers.map(c => <option key={c.id} value={c.id}>{c.companyName}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="billable" checked={form.billable}
                    onChange={e => setForm({ ...form, billable: e.target.checked })}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                  <label htmlFor="billable" className="text-sm text-gray-700 dark:text-gray-300">Billable</label>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
                  <textarea value={form.notes} rows={2}
                    onChange={e => setForm({ ...form, notes: e.target.value })}
                    placeholder="Additional notes..."
                    className="w-full border rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                </div>
                <div className="flex justify-end gap-3">
                  <button type="button" onClick={() => { setShowForm(false); resetForm(); }}
                    className="px-4 py-2 text-sm border rounded-lg text-gray-700 dark:text-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">
                    Cancel
                  </button>
                  <button type="submit" disabled={busy === 'save'}
                    className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
                    {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
                    {editId ? 'Update' : 'Save'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          </div>
        ) : tab === 'summary' ? (
          /* Summary Tab */
          <div className="space-y-6">
            {summary && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <SummaryCard label="Total Hours" value={fmtHours(summary.totalHours)} icon={<Clock className="w-5 h-5" />} color="blue" />
                  <SummaryCard label="Billable Hours" value={fmtHours(summary.billableHours)} icon={<CheckCircle className="w-5 h-5" />} color="green" />
                  <SummaryCard label="Non-Billable" value={fmtHours(summary.nonBillableHours)} icon={<Clock className="w-5 h-5" />} color="gray" />
                  <SummaryCard label="Total Value" value={fmt(summary.totalValue)} icon={<BarChart3 className="w-5 h-5" />} color="purple" />
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                  {/* By Project */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">By Project</h3>
                    {summary.byProject.length === 0 ? (
                      <p className="text-sm text-gray-500">No data</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                            <th className="pb-2">Project</th>
                            <th className="pb-2 text-right">Hours</th>
                            <th className="pb-2 text-right">Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.byProject.map(p => (
                            <tr key={p.projectName} className="border-b dark:border-gray-700/50">
                              <td className="py-2 text-gray-900 dark:text-white">{p.projectName}</td>
                              <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmtHours(p.hours)}</td>
                              <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmt(p.value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* By Customer */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">By Customer</h3>
                    {summary.byCustomer.length === 0 ? (
                      <p className="text-sm text-gray-500">No data</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                            <th className="pb-2">Customer</th>
                            <th className="pb-2 text-right">Hours</th>
                            <th className="pb-2 text-right">Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.byCustomer.map(c => (
                            <tr key={c.customerId} className="border-b dark:border-gray-700/50">
                              <td className="py-2 text-gray-900 dark:text-white">{c.customerName}</td>
                              <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmtHours(c.hours)}</td>
                              <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmt(c.value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          /* Entries Table */
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50 border-b dark:border-gray-700">
                    <th className="px-4 py-3 w-10">
                      <input type="checkbox" checked={entries.length > 0 && selected.size === entries.length}
                        onChange={toggleSelectAll}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                    </th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Project</th>
                    <th className="px-4 py-3">Task</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3 text-right">Hours</th>
                    <th className="px-4 py-3 text-right">Rate</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-center">Billable</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                        No time entries found. Click &quot;New Entry&quot; to get started.
                      </td>
                    </tr>
                  ) : entries.map(entry => (
                    <tr key={entry.id} className="border-b dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-3">
                        <input type="checkbox" checked={selected.has(entry.id)}
                          onChange={() => toggleSelect(entry.id)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      </td>
                      <td className="px-4 py-3 text-gray-900 dark:text-white whitespace-nowrap">
                        {new Date(entry.entryDate).toLocaleDateString('en-ZA')}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{entry.projectName || '-'}</td>
                      <td className="px-4 py-3 text-gray-900 dark:text-white max-w-xs truncate">{entry.taskDescription}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{entry.customerName || '-'}</td>
                      <td className="px-4 py-3 text-right text-gray-900 dark:text-white font-mono">{fmtHours(entry.hours)}</td>
                      <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400 font-mono">
                        {entry.rate != null ? fmt(entry.rate) : '-'}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-900 dark:text-white font-mono font-medium">
                        {entry.amount != null ? fmt(entry.amount) : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {entry.billable ? (
                          <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">Yes</span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">No</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium capitalize ${STATUS_COLORS[entry.status] || ''}`}>
                          {entry.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {entry.status === 'draft' && (
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleEdit(entry)}
                              className="p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400" title="Edit">
                              <Clock className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleDelete(entry.id)}
                              disabled={busy === entry.id}
                              className="p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400" title="Delete">
                              {busy === entry.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > entries.length && (
              <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 border-t dark:border-gray-700">
                Showing {entries.length} of {total} entries
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function SummaryCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    green: 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400',
    gray: 'bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    purple: 'bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-2 rounded-lg ${colors[color]}`}>{icon}</div>
        <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
      </div>
      <div className="text-xl font-bold text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}
