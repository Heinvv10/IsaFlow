import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Scale, Loader2, AlertCircle } from 'lucide-react';

interface Level { id: string; code: string; name: string; displayOrder: number }

interface Props {
  employeeId: string;
  currentLevelId: string | null;
  onChange: (id: string | null) => void;
}

export function OccupationalLevelCard({ employeeId, currentLevelId, onChange }: Props) {
  const [levels, setLevels] = useState<Level[]>([]);
  const [selected, setSelected] = useState(currentLevelId ?? '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/payroll/equity/occupational-levels');
      if (res.ok) {
        const json = await res.json();
        setLevels(((json.data ?? json) as Level[]) ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(currentLevelId ?? ''); }, [currentLevelId]);

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const occupationalLevelId = selected || null;
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/occupational-level`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ occupationalLevelId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message ?? j.error ?? 'Save failed');
        return;
      }
      onChange(occupationalLevelId);
    } finally {
      setSaving(false);
    }
  }

  const dirty = (currentLevelId ?? '') !== selected;

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <Scale className="h-5 w-5 text-sky-500" />
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">EE Occupational Level</h3>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />Loading levels...
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <select value={selected} onChange={e => setSelected(e.target.value)}
            className="flex-1 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
            <option value="">(Not set)</option>
            {levels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button onClick={save} disabled={!dirty || saving}
            className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}
      <p className="mt-2 text-xs text-[var(--ff-text-secondary)]">
        Drives the EEA2 annual return. Employees without a level fall into "Unspecified" on the report.
      </p>
      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4" />{error}
        </div>
      )}
    </div>
  );
}
