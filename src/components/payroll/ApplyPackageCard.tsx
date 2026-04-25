import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Package, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

interface Pkg {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface Props {
  employeeId: string;
}

export function ApplyPackageCard({ employeeId }: Props) {
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [selected, setSelected] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ inserted: number; ended: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/payroll/pay-packages?activeOnly=1');
      if (res.ok) {
        const json = await res.json();
        setPackages(((json.data ?? json) as Pkg[]) ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function apply(): Promise<void> {
    if (!selected) return;
    setApplying(true);
    setError('');
    setResult(null);
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/apply-package`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: selected, effectiveFrom }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? 'Apply failed');
        return;
      }
      const json = await res.json();
      setResult((json.data ?? json) as { inserted: number; ended: number });
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <Package className="h-5 w-5 text-sky-500" />
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Apply Pay Package</h3>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />Loading...
        </div>
      ) : packages.length === 0 ? (
        <div className="text-sm text-[var(--ff-text-secondary)]">
          No active packages. Create one under Setup → Pay Packages.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <select value={selected} onChange={e => setSelected(e.target.value)}
              className="col-span-2 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]">
              <option value="">Select package...</option>
              {packages.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
            <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)}
              className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
          </div>
          <div className="mt-3">
            <button onClick={apply} disabled={!selected || applying}
              className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
              {applying ? 'Applying...' : 'Apply package'}
            </button>
          </div>
          <p className="mt-3 text-xs text-[var(--ff-text-secondary)]">
            Applying end-dates any open assignment for each of the package&apos;s components, then inserts the new rows
            with the chosen effective date. Prior runs remain unchanged.
          </p>
        </>
      )}
      {result && (
        <div className="mt-3 flex items-center gap-2 text-sm text-green-400">
          <CheckCircle2 className="h-4 w-4" />
          Applied {result.inserted} component{result.inserted === 1 ? '' : 's'}
          {result.ended > 0 ? ` · ended ${result.ended} prior assignment${result.ended === 1 ? '' : 's'}` : ''}.
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4" />{error}
        </div>
      )}
    </div>
  );
}
