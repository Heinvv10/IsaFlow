/**
 * Bulk employee Search & Replace.
 * Route: /payroll/employees/bulk-update
 *
 * Two-step workflow: fill filter + update → Preview (read-only count + sample)
 * → Apply (transactional UPDATE + history write).
 */
import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Users, Loader2, AlertCircle, CheckCircle2, ChevronRight } from 'lucide-react';

interface CostCentre {
  id: string;
  code: string;
  name: string;
}

interface PreviewChange {
  from: string | null;
  to: string | null;
}
interface PreviewRow {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  changes: {
    department?: PreviewChange;
    costCentreId?: PreviewChange;
    employmentType?: PreviewChange;
  };
}
interface Preview {
  matchCount: number;
  sample: PreviewRow[];
}

const EMPLOYMENT_TYPES = ['permanent', 'contract', 'temporary', 'director'] as const;

function trimOrUndefined(v: string): string | undefined {
  const t = v.trim();
  return t === '' ? undefined : t;
}

export default function BulkUpdatePage() {
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [loading, setLoading] = useState(true);

  const [filterDepartment, setFilterDepartment] = useState('');
  const [filterCostCentreId, setFilterCostCentreId] = useState('');
  const [filterEmploymentType, setFilterEmploymentType] = useState('');

  const [updateDepartment, setUpdateDepartment] = useState('');
  const [updateCostCentreId, setUpdateCostCentreId] = useState<string>('__unchanged__');
  const [updateEmploymentType, setUpdateEmploymentType] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [changeReason, setChangeReason] = useState('');

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [applyResult, setApplyResult] = useState<{ updated: number } | null>(null);

  const loadCentres = useCallback(async () => {
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
  useEffect(() => {
    loadCentres().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load cost centres');
    });
  }, [loadCentres]);

  function buildPayload(): { filter: Record<string, unknown>; update: Record<string, unknown> } {
    const filter: Record<string, unknown> = {};
    const f1 = trimOrUndefined(filterDepartment);
    if (f1 !== undefined) filter.department = f1;
    if (filterCostCentreId) filter.costCentreId = filterCostCentreId;
    const f3 = trimOrUndefined(filterEmploymentType);
    if (f3 !== undefined) filter.employmentType = f3;

    const update: Record<string, unknown> = {};
    const u1 = trimOrUndefined(updateDepartment);
    if (u1 !== undefined) update.department = u1;
    if (updateCostCentreId === '__clear__') update.costCentreId = null;
    else if (updateCostCentreId !== '__unchanged__' && updateCostCentreId !== '') update.costCentreId = updateCostCentreId;
    const u3 = trimOrUndefined(updateEmploymentType);
    if (u3 !== undefined) update.employmentType = u3;

    return { filter, update };
  }

  async function runPreview(): Promise<void> {
    setPreviewing(true);
    setError('');
    setApplyResult(null);
    try {
      const { filter, update } = buildPayload();
      const res = await apiFetch('/api/payroll/employees/bulk/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter, update }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? 'Preview failed');
        setPreview(null);
        return;
      }
      const json = await res.json();
      setPreview((json.data ?? json) as Preview);
    } finally {
      setPreviewing(false);
    }
  }

  async function runApply(): Promise<void> {
    setApplying(true);
    setError('');
    try {
      const { filter, update } = buildPayload();
      const body: Record<string, unknown> = { filter, update };
      if (effectiveFrom) body.effectiveFrom = effectiveFrom;
      if (changeReason.trim()) body.changeReason = changeReason.trim();
      const res = await apiFetch('/api/payroll/employees/bulk/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? 'Apply failed');
        return;
      }
      const json = await res.json();
      setApplyResult((json.data ?? json) as { updated: number });
      setPreview(null);
    } finally {
      setApplying(false);
    }
  }

  const labelForCentre = (id: string | null): string => {
    if (!id) return '(none)';
    const c = centres.find(x => x.id === id);
    return c ? `${c.code} — ${c.name}` : id;
  };

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <Users className="h-6 w-6 text-sky-500" />
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Bulk Update Employees</h1>
        </div>

        <p className="text-sm text-[var(--ff-text-secondary)]">
          Find every active employee matching the filter, then set the chosen fields. A preview shows the exact
          changes; Apply runs inside a single transaction and writes one history entry per changed field.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">1. Filter — match these</h2>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-[var(--ff-text-secondary)]">Department</span>
                <input type="text" value={filterDepartment} onChange={e => setFilterDepartment(e.target.value)}
                  placeholder="(any)"
                  className="mt-1 w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
              </label>
              <label className="block">
                <span className="text-[var(--ff-text-secondary)]">Cost centre</span>
                <select value={filterCostCentreId} onChange={e => setFilterCostCentreId(e.target.value)}
                  disabled={loading}
                  className="mt-1 w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]">
                  <option value="">(any)</option>
                  {centres.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-[var(--ff-text-secondary)]">Employment type</span>
                <select value={filterEmploymentType} onChange={e => setFilterEmploymentType(e.target.value)}
                  className="mt-1 w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]">
                  <option value="">(any)</option>
                  {EMPLOYMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
          </section>

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">2. Update — set these fields</h2>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-[var(--ff-text-secondary)]">Department</span>
                <input type="text" value={updateDepartment} onChange={e => setUpdateDepartment(e.target.value)}
                  placeholder="(unchanged)"
                  className="mt-1 w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
              </label>
              <label className="block">
                <span className="text-[var(--ff-text-secondary)]">Cost centre</span>
                <select value={updateCostCentreId} onChange={e => setUpdateCostCentreId(e.target.value)}
                  disabled={loading}
                  className="mt-1 w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]">
                  <option value="__unchanged__">(unchanged)</option>
                  <option value="__clear__">Clear — set to Unassigned</option>
                  {centres.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-[var(--ff-text-secondary)]">Employment type</span>
                <select value={updateEmploymentType} onChange={e => setUpdateEmploymentType(e.target.value)}
                  className="mt-1 w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]">
                  <option value="">(unchanged)</option>
                  {EMPLOYMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3 pt-2">
                <label className="block">
                  <span className="text-[var(--ff-text-secondary)]">Effective from</span>
                  <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)}
                    className="mt-1 w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
                </label>
                <label className="block">
                  <span className="text-[var(--ff-text-secondary)]">Reason (optional)</span>
                  <input type="text" value={changeReason} onChange={e => setChangeReason(e.target.value)}
                    placeholder="e.g. Dept merge"
                    className="mt-1 w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
                </label>
              </div>
            </div>
          </section>
        </div>

        <div className="flex gap-3">
          <button onClick={runPreview} disabled={previewing}
            className="px-4 py-2 rounded-lg bg-[var(--ff-surface-secondary)] hover:bg-[var(--ff-surface-primary)] text-[var(--ff-text-primary)] border border-[var(--ff-border-primary)] text-sm font-medium disabled:opacity-50">
            {previewing ? <Loader2 className="h-4 w-4 animate-spin inline mr-1" /> : null}
            Preview
          </button>
          <button onClick={runApply}
            disabled={applying || !preview || preview.matchCount === 0}
            className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
            {applying ? <Loader2 className="h-4 w-4 animate-spin inline mr-1" /> : <ChevronRight className="h-4 w-4 inline mr-1" />}
            Apply to {preview?.matchCount ?? 0} employees
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />{error}
          </div>
        )}

        {applyResult && (
          <div className="flex items-center gap-2 text-sm text-green-400 rounded-lg border border-green-500/20 bg-green-500/10 p-3">
            <CheckCircle2 className="h-4 w-4" />
            Updated {applyResult.updated} employee{applyResult.updated === 1 ? '' : 's'}.
          </div>
        )}

        {preview && (
          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-3">
              Preview — {preview.matchCount} match{preview.matchCount === 1 ? '' : 'es'}
            </h2>
            {preview.sample.length === 0 ? (
              <div className="text-sm text-[var(--ff-text-secondary)]">No employees matched the filter.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-primary)]">
                    <tr>
                      <th className="py-2 pr-3">Emp #</th>
                      <th className="py-2 pr-3">Name</th>
                      <th className="py-2 pr-3">Field</th>
                      <th className="py-2 pr-3">From</th>
                      <th className="py-2 pr-3">To</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-primary)] text-[var(--ff-text-primary)]">
                    {preview.sample.flatMap(row => {
                      const entries = Object.entries(row.changes) as Array<[keyof PreviewRow['changes'], PreviewChange]>;
                      return entries.map(([field, change]) => (
                        <tr key={`${row.id}:${field}`}>
                          <td className="py-1.5 pr-3 font-mono text-xs">{row.employeeNumber}</td>
                          <td className="py-1.5 pr-3">{row.firstName} {row.lastName}</td>
                          <td className="py-1.5 pr-3 text-xs uppercase text-[var(--ff-text-secondary)]">{field}</td>
                          <td className="py-1.5 pr-3 text-[var(--ff-text-secondary)]">
                            {field === 'costCentreId' ? labelForCentre(change.from) : (change.from ?? '(empty)')}
                          </td>
                          <td className="py-1.5 pr-3">
                            {field === 'costCentreId' ? labelForCentre(change.to) : (change.to ?? '(empty)')}
                          </td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
                {preview.matchCount > preview.sample.length && (
                  <div className="mt-3 text-xs text-[var(--ff-text-secondary)]">
                    Showing first {preview.sample.length} of {preview.matchCount}. Apply will process all.
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </AppLayout>
  );
}
