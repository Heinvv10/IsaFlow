import { useEffect, useState, useCallback, useMemo } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Building2, Loader2, AlertCircle, Plus, X } from 'lucide-react';

interface CostCentre {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface Allocation {
  id?: string;
  costCentreId: string;
  percentage: number;
}

interface Props {
  employeeId: string;
  currentCostCentreId: string | null;
  onChange: (costCentreId: string | null) => void;
}

type Mode = 'single' | 'split';

export function CostCentreAssignmentCard({ employeeId, currentCostCentreId, onChange }: Props) {
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [mode, setMode] = useState<Mode>('single');
  const [selected, setSelected] = useState<string>(currentCostCentreId ?? '');
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [baseline, setBaseline] = useState<Allocation[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cRes, aRes] = await Promise.all([
        apiFetch('/api/payroll/cost-centres?activeOnly=1'),
        apiFetch(`/api/payroll/employees/${employeeId}/cost-allocations`),
      ]);
      if (cRes.ok) {
        const json = await cRes.json();
        setCentres((json.data ?? json) as CostCentre[]);
      }
      if (aRes.ok) {
        const json = await aRes.json();
        const list = ((json.data ?? json) as Allocation[]) ?? [];
        setAllocations(list);
        setBaseline(list);
        if (list.length > 0) setMode('split');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cost centres');
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelected(currentCostCentreId ?? ''); }, [currentCostCentreId]);

  const sum = useMemo(
    () => allocations.reduce((a, x) => a + (Number.isFinite(x.percentage) ? x.percentage : 0), 0),
    [allocations],
  );
  const sumOk = Math.abs(sum - 100) < 0.01 && allocations.length > 0;

  function addRow(): void {
    const taken = new Set(allocations.map(a => a.costCentreId));
    const next = centres.find(c => !taken.has(c.id));
    if (!next) return;
    setAllocations([...allocations, { costCentreId: next.id, percentage: 0 }]);
  }

  function updateRow(idx: number, patch: Partial<Allocation>): void {
    setAllocations(allocations.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }

  function removeRow(idx: number): void {
    setAllocations(allocations.filter((_, i) => i !== idx));
  }

  async function saveSingle(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      // If an employee previously had allocations, switching to single mode must clear them.
      if (baseline.length > 0) {
        const r = await apiFetch(`/api/payroll/employees/${employeeId}/cost-allocations`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allocations: [] }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.error?.message ?? j.message ?? 'Could not clear allocations');
          return;
        }
        setBaseline([]);
        setAllocations([]);
      }
      const costCentreId = selected || null;
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/cost-centre`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costCentreId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error?.message ?? json.message ?? 'Save failed');
        return;
      }
      onChange(costCentreId);
    } finally {
      setSaving(false);
    }
  }

  async function saveSplit(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/cost-allocations`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allocations: allocations.map(a => ({ costCentreId: a.costCentreId, percentage: a.percentage })),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? 'Save failed');
        return;
      }
      const json = await res.json();
      const saved = ((json.data ?? json) as Allocation[]) ?? [];
      setAllocations(saved);
      setBaseline(saved);
    } finally {
      setSaving(false);
    }
  }

  const singleDirty = (currentCostCentreId ?? '') !== selected || baseline.length > 0;
  const splitDirty = JSON.stringify(baseline) !== JSON.stringify(allocations);

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
        <>
          <div className="mb-4 flex gap-2">
            <button
              type="button"
              onClick={() => setMode('single')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border ${
                mode === 'single'
                  ? 'bg-sky-600 text-white border-sky-600'
                  : 'bg-transparent text-[var(--ff-text-secondary)] border-[var(--ff-border-primary)]'
              }`}
            >
              Single centre
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('split');
                if (allocations.length === 0 && selected) {
                  setAllocations([{ costCentreId: selected, percentage: 100 }]);
                }
              }}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border ${
                mode === 'split'
                  ? 'bg-sky-600 text-white border-sky-600'
                  : 'bg-transparent text-[var(--ff-text-secondary)] border-[var(--ff-border-primary)]'
              }`}
            >
              Split across centres
            </button>
          </div>

          {mode === 'single' ? (
            <div className="flex items-center gap-3">
              <select
                value={selected}
                onChange={e => setSelected(e.target.value)}
                className="flex-1 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]"
              >
                <option value="">(Unassigned)</option>
                {centres.map(c => (
                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                ))}
              </select>
              <button
                onClick={saveSingle}
                disabled={!singleDirty || saving}
                className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {allocations.map((a, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={a.costCentreId}
                    onChange={e => updateRow(idx, { costCentreId: e.target.value })}
                    className="flex-1 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]"
                  >
                    {centres.map(c => (
                      <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="100"
                    value={a.percentage}
                    onChange={e => updateRow(idx, { percentage: Number(e.target.value) })}
                    className="w-24 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)] text-right"
                  />
                  <span className="text-sm text-[var(--ff-text-secondary)]">%</span>
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    className="p-2 text-[var(--ff-text-secondary)] hover:text-red-400"
                    aria-label="Remove allocation"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={addRow}
                  disabled={allocations.length >= centres.length}
                  className="inline-flex items-center gap-1 text-xs text-sky-500 hover:text-sky-400 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" /> Add split
                </button>
                <span className={`text-sm font-medium ${sumOk ? 'text-green-400' : 'text-amber-400'}`}>
                  Total: {sum.toFixed(2)}%
                </span>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  onClick={saveSplit}
                  disabled={!sumOk || !splitDirty || saving}
                  className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50"
                  title={sumOk ? undefined : 'Percentages must sum to 100%'}
                >
                  {saving ? 'Saving...' : 'Save split'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4" />{error}
        </div>
      )}
    </div>
  );
}
