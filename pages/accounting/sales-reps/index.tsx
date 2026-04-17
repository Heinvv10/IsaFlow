/**
 * Sales Reps List Page
 * Route: /accounting/sales-reps
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, Plus, Search, Loader2, X, Pencil, UserX } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useCompany } from '@/contexts/CompanyContext';

interface SalesRep {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
}

interface FormState {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  commission_percent: string;
}

const EMPTY_FORM: FormState = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  commission_percent: '',
};

export default function SalesRepsPage() {
  const { activeCompany: company } = useCompany();
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editRep, setEditRep] = useState<SalesRep | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadReps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/sales-reps');
      const json = await res.json() as { data?: SalesRep[]; message?: string };
      if (!res.ok) {
        setError(json.message ?? 'Failed to load sales reps');
        setReps([]);
      } else {
        setReps(json.data ?? []);
      }
    } catch (err) {
      log.error('Failed to load sales reps', { err });
      setError('Network error — could not load sales reps');
      setReps([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadReps(); }, [loadReps]);

  const openAdd = () => {
    setEditRep(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (rep: SalesRep) => {
    setEditRep(rep);
    const parts = rep.name.trim().split(' ');
    const first = parts[0] ?? '';
    const last = parts.slice(1).join(' ');
    setForm({
      first_name: first,
      last_name: last,
      email: rep.email ?? '',
      phone: rep.phone ?? '',
      commission_percent: '',
    });
    setFormError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditRep(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const handleSave = async () => {
    const fullName = `${form.first_name.trim()} ${form.last_name.trim()}`.trim();
    if (!form.first_name.trim()) {
      setFormError('First name is required');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        name: fullName,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
      };

      let res: Response;
      if (editRep) {
        body.id = editRep.id;
        res = await apiFetch('/api/accounting/sales-reps', {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        res = await apiFetch('/api/accounting/sales-reps', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }

      const json = await res.json() as { message?: string };
      if (!res.ok) {
        setFormError(json.message ?? 'Save failed');
      } else {
        closeModal();
        await loadReps();
      }
    } catch (err) {
      log.error('Failed to save sales rep', { err });
      setFormError('Network error — save failed');
    }
    setSaving(false);
  };

  const handleDeactivate = async (rep: SalesRep) => {
    if (!confirm(`${rep.is_active ? 'Deactivate' : 'Reactivate'} "${rep.name}"?`)) return;
    try {
      const res = await apiFetch('/api/accounting/sales-reps', {
        method: 'PUT',
        body: JSON.stringify({ id: rep.id, is_active: !rep.is_active }),
      });
      const json = await res.json() as { message?: string };
      if (!res.ok) {
        setError(json.message ?? 'Update failed');
      } else {
        await loadReps();
      }
    } catch (err) {
      log.error('Failed to update sales rep', { err });
      setError('Network error — update failed');
    }
  };

  const filtered = reps.filter(r =>
    !search ||
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    (r.email ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const activeCount = reps.filter(r => r.is_active).length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-6 w-6 text-teal-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Sales Reps</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Manage your sales representatives
                  {company?.name ? ` for ${company.name}` : ''}
                </p>
              </div>
            </div>
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium transition-colors"
            >
              <Plus className="h-4 w-4" /> Add Sales Rep
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Reps</p>
              <p className="text-xl font-bold text-[var(--ff-text-primary)]">{reps.length}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Active</p>
              <p className="text-xl font-bold text-green-400">{activeCount}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Inactive</p>
              <p className="text-xl font-bold text-gray-600 dark:text-gray-400">{reps.length - activeCount}</p>
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Search */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                placeholder="Search by name or email..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="ff-input pl-9 text-sm w-72"
              />
            </div>
          </div>

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      {search ? 'No sales reps match your search.' : (
                        <>No sales reps yet.{' '}
                          <button onClick={openAdd} className="text-teal-400 hover:underline">
                            Add your first sales rep
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )}
                {!loading && filtered.map(rep => (
                  <tr
                    key={rep.id}
                    className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                  >
                    <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">
                      {rep.name}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {rep.email ?? <span className="text-[var(--ff-text-tertiary)]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {rep.phone ?? <span className="text-[var(--ff-text-tertiary)]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {rep.is_active ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/10 text-gray-600 dark:text-gray-400">
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={() => openEdit(rep)}
                          title="Edit"
                          className="p-1.5 rounded text-[var(--ff-text-secondary)] hover:text-teal-400 hover:bg-teal-500/10 transition-colors"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDeactivate(rep)}
                          title={rep.is_active ? 'Deactivate' : 'Reactivate'}
                          className="p-1.5 rounded text-[var(--ff-text-secondary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <UserX className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Add / Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-md mx-4">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ff-border-light)]">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                {editRep ? 'Edit Sales Rep' : 'Add Sales Rep'}
              </h2>
              <button
                onClick={closeModal}
                className="p-1.5 rounded text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)] transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal body */}
            <div className="px-6 py-5 space-y-4">
              {formError && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-400">
                  {formError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
                    First Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.first_name}
                    onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                    placeholder="Jane"
                    className="ff-input w-full text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
                    Last Name
                  </label>
                  <input
                    type="text"
                    value={form.last_name}
                    onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                    placeholder="Smith"
                    className="ff-input w-full text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="jane@example.com"
                  className="ff-input w-full text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
                  Phone
                </label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="+27 82 000 0000"
                  className="ff-input w-full text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
                  Commission %
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={form.commission_percent}
                  onChange={e => setForm(f => ({ ...f, commission_percent: e.target.value }))}
                  placeholder="0.0"
                  className="ff-input w-full text-sm"
                />
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                  Stored for reference — not yet applied to transactions.
                </p>
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--ff-border-light)]">
              <button
                onClick={closeModal}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium transition-colors disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editRep ? 'Save Changes' : 'Add Sales Rep'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
