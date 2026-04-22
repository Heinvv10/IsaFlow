/**
 * New Expense Claim (PRD-05 Phase 10)
 * Pick employee + date + title, creates a draft claim, redirects to detail.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { ChevronLeft, Loader2 } from 'lucide-react';

interface Employee { id: string; first_name: string; last_name: string; email: string }

export default function NewExpenseClaim() {
  const router = useRouter();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [claimDate, setClaimDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch('/api/payroll/employees');
        const json = await res.json() as { data?: Employee[] | { items?: Employee[] } };
        const list = Array.isArray(json.data) ? json.data : json.data?.items ?? [];
        setEmployees(list);
        if (list[0]) setEmployeeId(list[0].id);
      } catch { /* ignore */ }
    })();
  }, []);

  async function handleCreate() {
    if (!employeeId) { setError('Select an employee'); return; }
    setSaving(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/expense-claims', {
        method: 'POST',
        body: JSON.stringify({ employeeId, claimDate, title: title || null, description: description || null }),
      });
      const json = await res.json() as { data?: { claim?: { id: string } }; error?: { message?: string } | string };
      if (!res.ok || !json.data?.claim) {
        setError(typeof json.error === 'string' ? json.error : json.error?.message ?? 'Create failed');
        return;
      }
      await router.push(`/accounting/expenses/${json.data.claim.id}`);
    } catch { setError('Network error'); }
    finally { setSaving(false); }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
          <Link href="/accounting/expenses" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 mb-1">
            <ChevronLeft className="h-3 w-3" /> Expense claims
          </Link>
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New claim</h1>
        </div>
        <div className="max-w-xl mx-auto px-6 py-8">
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6 space-y-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Employee</label>
              <select value={employeeId} onChange={e => setEmployeeId(e.target.value)}
                className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-sm">
                <option value="">Select…</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Claim date</label>
              <input type="date" value={claimDate} onChange={e => setClaimDate(e.target.value)}
                className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Title</label>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="April 2026 travel"
                className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Description (optional)</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-sm" />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Link href="/accounting/expenses" className="px-4 py-2 text-sm text-slate-300 hover:bg-white/5 rounded">Cancel</Link>
              <button onClick={() => void handleCreate()} disabled={saving}
                className="px-4 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-60">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create draft'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
