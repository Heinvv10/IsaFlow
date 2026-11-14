/**
 * Admin — Plan Management
 * Create, edit, and archive billing plans.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { PlanFormModal, EMPTY_PLAN_FORM as EMPTY_FORM, type PlanForm } from '@/components/admin/billing/PlanFormModal';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { AlertCircle, Loader2, Plus, Pencil, Archive } from 'lucide-react';

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string;
  monthly_price_cents: number;
  annual_price_cents: number;
  currency: string;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  is_active: boolean;
  display_order: number;
  created_at: string;
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
  // The prices the edited plan had: a change reprices every subscriber, so it needs a confirm (audit 4.17).
  const [origPrices, setOrigPrices] = useState<{ monthly: number; annual: number } | null>(null);
  const [repriceBody, setRepriceBody] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch('/api/admin/billing/plans?include_archived=true');
      await assertOk(res, 'Could not load the plans - try again');
      const json = await res.json();
      setPlans((json.data ?? []) as Plan[]);
    } catch (err) {
      setPlans([]);
      setError(apiErrorMessage(err, 'Could not load the plans - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openAdd() {
    setEditId(null);
    setOrigPrices(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
  }

  function openEdit(plan: Plan) {
    setEditId(plan.id);
    setOrigPrices({ monthly: plan.monthly_price_cents, annual: plan.annual_price_cents });
    setForm({
      code:          plan.code,
      name:          plan.name,
      description:   plan.description,
      monthly_price: String(plan.monthly_price_cents / 100),
      annual_price:  String(plan.annual_price_cents / 100),
      users_limit:   (plan.limits as Record<string, unknown>)?.users != null ? String((plan.limits as Record<string, unknown>).users) : '',
      features:      JSON.stringify(plan.features, null, 2),
      limits:        JSON.stringify(plan.limits, null, 2),
    });
    setFormError('');
    setShowForm(true);
  }

  async function handleSave() {
    setFormError('');
    let features: unknown, limits: Record<string, unknown>;
    try { features = JSON.parse(form.features); } catch { setFormError('Features must be valid JSON'); return; }
    try {
      const parsed = JSON.parse(form.limits);
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
      limits = parsed as Record<string, unknown>;
    } catch { setFormError('Limits must be a valid JSON object'); return; }

    if (form.users_limit.trim() !== '') {
      const n = parseInt(form.users_limit, 10);
      if (!Number.isFinite(n) || n < 0) { setFormError('Users Limit must be a non-negative integer'); return; }
      limits = { ...limits, users: n };
    }

    const monthly = Math.round(parseFloat(form.monthly_price) * 100);
    const annual  = Math.round(parseFloat(form.annual_price)  * 100);
    if (!Number.isFinite(monthly) || !Number.isFinite(annual) || monthly < 0 || annual < 0) {
      setFormError('Monthly and annual prices must be amounts in rands (0 or more)'); return;
    }
    const commonBody = {
      name:               form.name,
      description:        form.description,
      monthly_price_cents: monthly,
      annual_price_cents:  annual,
      features,
      limits,
    };
    // The code is fixed once a plan exists: the PATCH schema is strict and answers 400 to a `code`, so edit never sends it.
    const body = editId ? commonBody : { code: form.code, ...commonBody };
    if (origPrices && (monthly !== origPrices.monthly || annual !== origPrices.annual)) {
      setRepriceBody(body);
      return;
    }
    await submit(body);
  }

  async function submit(body: Record<string, unknown>) {
    setRepriceBody(null);
    setSaving(true);
    try {
      const res  = editId
        ? await apiFetch(`/api/admin/billing/plans/${editId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' }, body: JSON.stringify(body) })
        : await apiFetch('/api/admin/billing/plans',           { method: 'POST',  headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' }, body: JSON.stringify(body) });
      await assertOk(res, 'Could not save the plan - try again');
      setShowForm(false);
      void load();
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not save the plan - try again'));
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(id: string) {
    if (!confirm('Archive this plan? Existing subscriptions will not be affected.')) return;
    try {
      const res  = await apiFetch(`/api/admin/billing/plans/${id}`, { method: 'DELETE', headers: { 'X-Admin-Request': 'true' } });
      await assertOk(res, 'Could not archive the plan - try again');
      void load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not archive the plan - try again'));
    }
  }

  return (
    <AdminLayout title="Billing Plans">
      <div className="flex items-center justify-between mb-5">
        <span className="text-sm text-gray-500 dark:text-gray-400">{plans.length} plan{plans.length !== 1 ? 's' : ''}</span>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Plan
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      <PlanFormModal
        open={showForm}
        editing={editId !== null}
        trapFocus={repriceBody === null}
        form={form}
        setForm={setForm}
        error={formError}
        saving={saving}
        onSave={() => void handleSave()}
        onClose={() => setShowForm(false)}
      />

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
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && plans.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" /></td></tr>
              )}
              {!loading && plans.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-600 dark:text-gray-400">No plans found</td></tr>
              )}
              {plans.map(p => (
                <tr key={p.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{p.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{p.code}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 tabular-nums text-xs">{formatCurrency(p.monthly_price_cents / 100)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 tabular-nums text-xs">{formatCurrency(p.annual_price_cents / 100)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${!p.is_active ? 'bg-gray-500/10 text-gray-500' : 'bg-teal-500/10 text-teal-600 dark:text-teal-400'}`}>
                      {p.is_active ? 'Active' : 'Archived'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(p)} className="p-1.5 rounded text-gray-600 dark:text-gray-400 hover:text-teal-500 hover:bg-teal-500/10 transition-colors" title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {p.is_active && (
                        <button onClick={() => void handleArchive(p.id)} className="p-1.5 rounded text-gray-600 dark:text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Archive">
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
      <ConfirmModal
        open={repriceBody !== null}
        title="Reprice every subscriber?"
        message={<>The new price applies to <strong>every subscription on {form.name || 'this plan'}</strong> from its next
          charge, and MRR changes immediately. Subscriptions do not keep the old price. Save the new price?</>}
        confirmLabel="Save new price"
        confirmClass="bg-amber-500 hover:bg-amber-600"
        loading={saving}
        onConfirm={() => { if (repriceBody) void submit(repriceBody); }}
        onCancel={() => setRepriceBody(null)}
      />
    </AdminLayout>
  );
}
