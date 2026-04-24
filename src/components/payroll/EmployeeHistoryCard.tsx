import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { History, Loader2 } from 'lucide-react';

interface HistoryEntry {
  id: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  effectiveFrom: string;
  changeReason: string | null;
  changedByName: string | null;
  createdAt: string;
}

interface Props {
  employeeId: string;
}

const FIELD_LABELS: Record<string, string> = {
  employment_type: 'Employment type',
  department: 'Department',
  cost_centre_id: 'Cost centre',
};

function formatValue(fieldName: string, value: string | null): string {
  if (value === null) return '(none)';
  if (fieldName === 'cost_centre_id') return value.slice(0, 8) + '…';
  return value;
}

export function EmployeeHistoryCard({ employeeId }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/history`);
      if (res.ok) {
        const json = await res.json();
        setEntries(((json.data ?? json) as HistoryEntry[]) ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [employeeId]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <History className="h-5 w-5 text-sky-500" />
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Change History</h3>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading history...
        </div>
      ) : entries.length === 0 ? (
        <div className="text-sm text-[var(--ff-text-secondary)]">
          No recorded changes yet. History tracks department, cost centre and employment-type changes.
        </div>
      ) : (
        <ul className="space-y-3 text-sm">
          {entries.map(e => (
            <li key={e.id} className="flex items-start gap-3 border-l-2 border-sky-500/40 pl-3">
              <div className="flex-1">
                <div className="text-[var(--ff-text-primary)]">
                  <span className="font-medium">{FIELD_LABELS[e.fieldName] ?? e.fieldName}:</span>{' '}
                  <span className="text-[var(--ff-text-secondary)]">{formatValue(e.fieldName, e.oldValue)}</span>
                  {' → '}
                  <span>{formatValue(e.fieldName, e.newValue)}</span>
                </div>
                <div className="mt-0.5 text-xs text-[var(--ff-text-secondary)]">
                  Effective {e.effectiveFrom}
                  {e.changedByName ? ` · by ${e.changedByName}` : ''}
                  {e.changeReason ? ` · ${e.changeReason}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
