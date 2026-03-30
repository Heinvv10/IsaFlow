/**
 * Admin — Plan Management
 * Create, edit, and archive billing plans.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2, Plus, Pencil, Archive, X, Check } from 'lucide-react';

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  usersLimit: number | null;
  isArchived: boolean;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
}

interface PlanForm {
  code: string;
  name: string;
  description: string;
  monthly_price: string;
  annual_price: string;
  users_limit: string;
  features: string;
  limits: string;
}

const EMPTY_FORM: PlanForm = {
  code: '', name: '', description: '',
  monthly_price: '', annual_price: '',
  users_limit: '', features: '{}', limits: '{}',
};

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });
}

export default function PlansPage() {
  const [plans, setPlans]         = useState<Plan[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving]       = useState(false);
  const [showForm, setShowForm]   = useState(false);
  const [editId, setEditId]       = useState<string | null>(null);
  const [form, setForm]           = useState<PlanForm>(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch('/api/admin/billing/plans?include_archived=true');
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load plans');
      setPlans((json.data ?? []) as Plan[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openAdd() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
  }

  function openEdit(plan: Plan) {
    setEditId(plan.id);
    setForm({
      code:          plan.code,
      name:          plan.name,
      description:   plan.description,
      monthly_price: String(plan.monthlyPriceCents / 100),
      annual_price:  String(plan.annualPriceCents / 100),
      users_limit:   plan.usersLimit != null ? String(plan.usersLimit) : '',
      features:      JSON.stringify(plan.features, null, 2),
      limits:        JSON.stringify(plan.limits, null, 2),
    });
    setFormError('');
    setShowForm(true);
  }

  async function handleSave() {
    setFormError('');
    let features: unknown, limits: unknown;
    try { features = JSON.parse(form.features); } catch { setFormError('Features must be valid JSON'); return; }
    try { limits   = JSON.parse(form.limits);   } catch { setFormError('Limits must be valid JSON'); return; }

    const body = {
      code:               form.code,
      name:               form.name,
      description:        form.description,
      monthly_price_cents: Math.round(parseFloat(form.monthly_price) * 100),
      annual_price_cents:  Math.round(parseFloat(form.annual_price)  * 100),
      users_limit:        form.users_limit ? parseInt(form.users_limit) : null,
      features,
      limits,
    };

    setSaving(true);
    try {
      const res  = editId
        ? await apiFetch(`/api/admin/billing/plans/${editId}`, { method: 'PUT',  body: JSON.stringify(body) })
        : await apiFetch('/api/admin/billing/plans',            { method: 'POST', body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Save failed');
      setShowForm(false);
      void load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(id: string) {
    if (!confirm('Archive this plan? Existing subscriptions will not be affected.')) return;
    try {
      const res  = await apiFetch(`/api/admin/billing/plans/${id}/archive`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Archive failed');
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive failed');
    }
  }

  function field(key: keyof PlanForm, label: string, opts?: { type?: string; rows?: number }) {
    const isTextarea = !!opts?.rows;
    const cls = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500';
    return (
      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</label>
        {isTextarea
          ? <textarea rows={opts!.rows} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} className={cls} />
          : <input type={opts?.type ?? 'text'} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} className={cls} />
        }
      </div>
    );
  }

  return (
    <AdminLayout title="Billing Plans">
      <div className="flex items-center justify-between mb-5">
        <span className="text-sm text-gray-500 dark:text-gray-400">{plans.length} plan{plans.length !== 1 ? 's' : ''}</span>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Plan
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Plan Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{editId ? 'Edit Plan' : 'Add Plan'}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-xs">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" /> {formError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                {field('code', 'Code (e.g. starter)')}
                {field('name', 'Name')}
              </div>
              {field('description', 'Description')}
              <div className="grid grid-cols-3 gap-4">
                {field('monthly_price', 'Monthly Price (R)', { type: 'number' })}
                {field('annual_price',  'Annual Price (R)',  { type: 'number' })}
                {field('users_limit',   'Users Limit',       { type: 'number' })}
              </div>
              {field('features', 'Features (JSON)', { rows: 4 })}
              {field('limits',   'Limits (JSON)',   { rows: 4 })}
            </div>
            <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">Cancel</button>
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {editId ? 'Save Changes' : 'Create Plan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Monthly</th>
                <th className="px-4 py-3 font-medium">Annual</th>
                <th className="px-4 py-3 font-medium">Users</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && plans.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" /></td></tr>
              )}
              {!loading && plans.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400">No plans found</td></tr>
              )}
              {plans.map(p => (
                <tr key={p.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{p.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{p.code}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">{fmtZAR(p.monthlyPriceCents)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">{fmtZAR(p.annualPriceCents)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{p.usersLimit ?? 'Unlimited'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${p.isArchived ? 'bg-gray-500/10 text-gray-500' : 'bg-teal-500/10 text-teal-600 dark:text-teal-400'}`}>
                      {p.isArchived ? 'Archived' : 'Active'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(p)} className="p-1.5 rounded text-gray-400 hover:text-teal-500 hover:bg-teal-500/10 transition-colors" title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {!p.isArchived && (
                        <button onClick={() => void handleArchive(p.id)} className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Archive">
                          <Archive className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
