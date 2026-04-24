/**
 * Pay Package editor — rename + manage component rows.
 * Route: /payroll/pay-packages/[id]
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Package, ArrowLeft, Loader2, AlertCircle, Plus, X, Save } from 'lucide-react';

interface Component {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: string;
  isActive: boolean;
}

interface PackageComponent {
  id?: string;
  componentId: string;
  amount: number;
  isRecurring: boolean;
}

interface Pkg {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  components: Array<{
    id: string;
    componentId: string;
    componentName: string;
    sarsSourceCode: string;
    componentType: string;
    amount: number;
    isRecurring: boolean;
  }>;
}

export default function PayPackageEditPage() {
  const router = useRouter();
  const { id } = router.query;
  const packageId = typeof id === 'string' ? id : '';

  const [pkg, setPkg] = useState<Pkg | null>(null);
  const [allComponents, setAllComponents] = useState<Component[]>([]);
  const [rows, setRows] = useState<PackageComponent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!packageId) return;
    setLoading(true);
    try {
      const [pRes, cRes] = await Promise.all([
        apiFetch(`/api/payroll/pay-packages/${packageId}`),
        apiFetch('/api/payroll/components'),
      ]);
      if (pRes.ok) {
        const json = await pRes.json();
        const loaded = (json.data ?? json) as Pkg;
        setPkg(loaded);
        setRows(loaded.components.map(c => ({
          componentId: c.componentId, amount: c.amount, isRecurring: c.isRecurring,
        })));
      }
      if (cRes.ok) {
        const json = await cRes.json();
        setAllComponents(((json.data ?? json) as Component[]) ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [packageId]);
  useEffect(() => { load(); }, [load]);

  function addRow(): void {
    const taken = new Set(rows.map(r => r.componentId));
    const next = allComponents.find(c => c.isActive && !taken.has(c.id));
    if (!next) return;
    setRows([...rows, { componentId: next.id, amount: 0, isRecurring: true }]);
  }

  async function save(): Promise<void> {
    if (!pkg) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/pay-packages/${packageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ components: rows }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message ?? j.error ?? 'Save failed');
        return;
      }
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (loading || !pkg) {
    return (
      <AppLayout>
        <div className="max-w-4xl mx-auto px-6 py-6">
          <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin" />Loading package...
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        <Link href="/payroll/pay-packages" className="inline-flex items-center gap-1 text-sm text-sky-500 hover:text-sky-400">
          <ArrowLeft className="h-4 w-4" /> Back to packages
        </Link>

        <div className="flex items-center gap-3">
          <Package className="h-6 w-6 text-sky-500" />
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
            <span className="font-mono mr-2">{pkg.code}</span>{pkg.name}
          </h1>
        </div>

        {pkg.description && (
          <p className="text-sm text-[var(--ff-text-secondary)]">{pkg.description}</p>
        )}

        <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Components</h2>
            <button onClick={addRow}
              disabled={rows.length >= allComponents.filter(c => c.isActive).length}
              className="inline-flex items-center gap-1 text-xs text-sky-500 hover:text-sky-400 disabled:opacity-50">
              <Plus className="h-4 w-4" /> Add component
            </button>
          </div>

          {rows.length === 0 ? (
            <div className="text-sm text-[var(--ff-text-secondary)]">No components yet. Add one to start.</div>
          ) : (
            <div className="space-y-2">
              {rows.map((r, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select value={r.componentId}
                    onChange={e => setRows(rows.map((x, i) => i === idx ? { ...x, componentId: e.target.value } : x))}
                    className="flex-1 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
                    {allComponents.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.sarsSourceCode})</option>
                    ))}
                  </select>
                  <input type="number" step="0.01" value={r.amount}
                    onChange={e => setRows(rows.map((x, i) => i === idx ? { ...x, amount: Number(e.target.value) } : x))}
                    className="w-32 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-right text-[var(--ff-text-primary)]" />
                  <label className="inline-flex items-center gap-1 text-xs text-[var(--ff-text-secondary)]">
                    <input type="checkbox" checked={r.isRecurring}
                      onChange={e => setRows(rows.map((x, i) => i === idx ? { ...x, isRecurring: e.target.checked } : x))} />
                    Recurring
                  </label>
                  <button onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                    className="p-2 text-[var(--ff-text-secondary)] hover:text-red-400">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button onClick={save} disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
              <Save className="h-4 w-4" /> {saving ? 'Saving...' : 'Save components'}
            </button>
          </div>

          {error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-400">
              <AlertCircle className="h-4 w-4" />{error}
            </div>
          )}
        </section>
      </div>
    </AppLayout>
  );
}
