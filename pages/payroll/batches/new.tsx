/**
 * New Batch — pick type (component_values / reimbursive_travel), period,
 * component (for component batches), then create draft and redirect to grid.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Layers, Save, Loader2 } from 'lucide-react';

interface Component {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function NewBatchPage() {
  const router = useRouter();
  const now = new Date();
  const [batchType, setBatchType] = useState<'component_values' | 'reimbursive_travel'>('component_values');
  const [componentId, setComponentId] = useState('');
  const [description, setDescription] = useState('');
  const [periodYear, setPeriodYear] = useState(now.getFullYear());
  const [periodMonth, setPeriodMonth] = useState(now.getMonth() + 1);
  const [isRecurring, setIsRecurring] = useState(false);
  const [components, setComponents] = useState<Component[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const res = await apiFetch('/api/payroll/components');
      if (res.ok) {
        const json = await res.json();
        setComponents((json.data ?? json) as Component[]);
      }
    })();
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError('');
    if (batchType === 'component_values' && !componentId) {
      setError('Select a component');
      return;
    }
    if (!description.trim()) {
      setError('Description is required');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/payroll/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchType,
          componentId: batchType === 'component_values' ? componentId : undefined,
          description: description.trim(),
          periodYear,
          periodMonth,
          isRecurring,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? json.message ?? 'Create failed');
        return;
      }
      const id = (json.data ?? json).id as string;
      await router.push(`/payroll/batches/${id}`);
    } catch {
      setError('Create failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-6 py-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-indigo-500/10"><Layers className="h-6 w-6 text-indigo-500" /></div>
          <div>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Batch</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Capture payroll amounts for many employees in one go</p>
          </div>
        </div>

        <div className="p-6 max-w-3xl">
          <form onSubmit={submit} className="space-y-5 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-6">
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-2">Batch Type</label>
              <div className="grid grid-cols-2 gap-3">
                <button type="button" onClick={() => setBatchType('component_values')}
                  className={`p-4 rounded-lg border text-left ${batchType === 'component_values' ? 'border-indigo-500 bg-indigo-500/10' : 'border-[var(--ff-border-primary)]'}`}>
                  <div className="font-medium text-[var(--ff-text-primary)]">Component values</div>
                  <div className="text-xs text-[var(--ff-text-secondary)] mt-1">Pick one pay component (bonus, overtime, etc.) then capture an amount per employee.</div>
                </button>
                <button type="button" onClick={() => setBatchType('reimbursive_travel')}
                  className={`p-4 rounded-lg border text-left ${batchType === 'reimbursive_travel' ? 'border-indigo-500 bg-indigo-500/10' : 'border-[var(--ff-border-primary)]'}`}>
                  <div className="font-medium text-[var(--ff-text-primary)]">Reimbursive travel</div>
                  <div className="text-xs text-[var(--ff-text-secondary)] mt-1">Capture km + rate per employee; splits into SARS 3702 (taxable) and 3703 (non-taxable) on post.</div>
                </button>
              </div>
            </div>

            {batchType === 'component_values' && (
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-2">Component</label>
                <select value={componentId} onChange={e => setComponentId(e.target.value)}
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
                  <option value="">Select a component</option>
                  {components.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.sarsSourceCode})</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-2">Description</label>
              <input value={description} onChange={e => setDescription(e.target.value)}
                placeholder="e.g. April overtime"
                className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-2">Period Month</label>
                <select value={periodMonth} onChange={e => setPeriodMonth(Number(e.target.value))}
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-2">Period Year</label>
                <input type="number" value={periodYear} onChange={e => setPeriodYear(Number(e.target.value))}
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]" />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
              <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} />
              Apply as recurring (every period until ended) — default is once-off
            </label>

            {error && <div className="text-sm text-red-400">{error}</div>}

            <div className="flex justify-end gap-3 pt-3">
              <button type="button" onClick={() => router.back()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">Cancel</button>
              <button type="submit" disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Create Batch
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
