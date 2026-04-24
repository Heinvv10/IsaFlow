import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Building2, Loader2, AlertCircle } from 'lucide-react';

interface CostCentre {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface Props {
  employeeId: string;
  currentCostCentreId: string | null;
  onChange: (costCentreId: string | null) => void;
}

export function CostCentreAssignmentCard({ employeeId, currentCostCentreId, onChange }: Props) {
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>(currentCostCentreId ?? '');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/payroll/cost-centres?activeOnly=1');
      if (res.ok) {
        const json = await res.json();
        setCentres((json.data ?? json) as CostCentre[]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(currentCostCentreId ?? ''); }, [currentCostCentreId]);

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const costCentreId = selected || null;
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/cost-centre`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costCentreId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.message ?? json.error ?? 'Save failed');
        return;
      }
      onChange(costCentreId);
    } finally {
      setSaving(false);
    }
  }

  const dirty = (currentCostCentreId ?? '') !== selected;

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <Building2 className="h-5 w-5 text-sky-500" />
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Cost Centre</h3>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading cost centres...
        </div>
      ) : centres.length === 0 ? (
        <div className="text-sm text-[var(--ff-text-secondary)]">
          No active cost centres. Create one under Setup → Cost Centres first.
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <select value={selected} onChange={e => setSelected(e.target.value)}
            className="flex-1 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
            <option value="">(Unassigned)</option>
            {centres.map(c => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </select>
          <button onClick={save} disabled={!dirty || saving}
            className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
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
