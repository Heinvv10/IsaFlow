import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Scale, Loader2, AlertCircle } from 'lucide-react';

interface PayScale {
  id: string;
  code: string;
  name: string;
  gradeLevel: number;
  minSalary: number;
  midSalary: number;
  maxSalary: number;
  isActive: boolean;
}

interface Props {
  employeeId: string;
  currentPayScaleId: string | null;
  onChange: (id: string | null) => void;
}

export function PayScaleCard({ employeeId, currentPayScaleId, onChange }: Props) {
  const [scales, setScales] = useState<PayScale[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>(currentPayScaleId ?? '');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/payroll/pay-scales?activeOnly=1');
      if (res.ok) {
        const json = await res.json();
        setScales(((json.data ?? json) as PayScale[]) ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pay scales');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelected(currentPayScaleId ?? ''); }, [currentPayScaleId]);

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const payScaleId = selected || null;
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/pay-scale`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payScaleId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? 'Save failed');
        return;
      }
      onChange(payScaleId);
    } finally {
      setSaving(false);
    }
  }

  const dirty = (currentPayScaleId ?? '') !== selected;
  const current = scales.find(s => s.id === selected);

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <Scale className="h-5 w-5 text-sky-500" />
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Pay Scale</h3>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />Loading...
        </div>
      ) : scales.length === 0 ? (
        <div className="text-sm text-[var(--ff-text-secondary)]">
          No active pay scales. Create one under Setup → Pay Scales.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <select value={selected} onChange={e => setSelected(e.target.value)}
              className="flex-1 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
              <option value="">(Unassigned)</option>
              {scales.map(s => (
                <option key={s.id} value={s.id}>G{s.gradeLevel} · {s.code} — {s.name}</option>
              ))}
            </select>
            <button onClick={save} disabled={!dirty || saving}
              className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {current && (
            <div className="mt-3 text-xs text-[var(--ff-text-secondary)]">
              Band: R{current.minSalary.toLocaleString()} — R{current.midSalary.toLocaleString()} — R{current.maxSalary.toLocaleString()}
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
