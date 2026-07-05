/**
 * Batch grid — capture values per employee, validate, post.
 * Route: /payroll/batches/[id]
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { Layers, Loader2, AlertCircle, CheckCircle2, Send, Plus, Trash2, ArrowLeft } from 'lucide-react';

interface Employee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

interface BatchLine {
  id: string;
  employeeId: string;
  employeeName?: string;
  employeeNumber?: string;
  value: number;
  km: number | null;
  ratePerKm: number | null;
  taxablePortion: number | null;
  nonTaxablePortion: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  error: string | null;
  notes: string | null;
}

interface Batch {
  id: string;
  batchType: 'component_values' | 'reimbursive_travel';
  componentId: string | null;
  description: string;
  periodYear: number;
  periodMonth: number;
  isRecurring: boolean;
  status: 'draft' | 'validated' | 'posted' | 'cancelled';
  lineCount: number;
  totalAmount: number;
}

interface NewLineDraft {
  employeeId: string;
  value: string;
  km: string;
  ratePerKm: string;
  taxablePortion: string;
  nonTaxablePortion: string;
  effectiveFrom: string;
}

const SARS_PRESCRIBED_RATE_PER_KM = 4.64;

function endOfMonth(year: number, month: number): string {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

export default function BatchGridPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [batch, setBatch] = useState<Batch | null>(null);
  const [lines, setLines] = useState<BatchLine[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const isEditable = batch?.status === 'draft' || batch?.status === 'validated';
  const defaultEffectiveFrom = batch ? endOfMonth(batch.periodYear, batch.periodMonth) : '';

  const emptyDraft: NewLineDraft = useMemo(
    () => ({ employeeId: '', value: '', km: '', ratePerKm: '', taxablePortion: '', nonTaxablePortion: '', effectiveFrom: '' }),
    [],
  );
  const [drafts, setDrafts] = useState<NewLineDraft[]>([emptyDraft]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const [batchRes, empRes] = await Promise.all([
        apiFetch(`/api/payroll/batches/${id}`),
        apiFetch('/api/payroll/employees'),
      ]);
      if (!batchRes.ok) throw new Error(`HTTP ${batchRes.status}`);
      const batchJson = await batchRes.json();
      const payload = (batchJson.data ?? batchJson) as { batch: Batch; lines: BatchLine[] };
      setBatch(payload.batch);
      setLines(payload.lines);
      if (empRes.ok) {
        const empJson = await empRes.json();
        setEmployees((empJson.data ?? empJson) as Employee[]);
      }
    } catch {
      setError('Failed to load batch');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const usedEmployeeIds = new Set(lines.map(l => l.employeeId));
  const availableEmployees = employees.filter(e => !usedEmployeeIds.has(e.id));

  function updateDraft(i: number, patch: Partial<NewLineDraft>): void {
    setDrafts(drafts.map((d, idx) => idx === i ? { ...d, ...patch } : d));
  }

  function addDraftRow(): void {
    setDrafts([...drafts, emptyDraft]);
  }

  function removeDraft(i: number): void {
    setDrafts(drafts.filter((_, idx) => idx !== i));
  }

  function buildLinePayload(draft: NewLineDraft): Record<string, unknown> | null {
    if (!draft.employeeId) return null;
    const effectiveFrom = draft.effectiveFrom || defaultEffectiveFrom;
    if (!effectiveFrom) return null;
    const base: Record<string, unknown> = { employeeId: draft.employeeId, effectiveFrom };
    if (batch?.batchType === 'reimbursive_travel') {
      const km = Number(draft.km);
      const rate = Number(draft.ratePerKm);
      if (!Number.isFinite(km) || !Number.isFinite(rate) || km <= 0 || rate <= 0) return null;
      const nonTaxable = Math.min(rate, SARS_PRESCRIBED_RATE_PER_KM) * km;
      const taxable = Math.max(0, rate - SARS_PRESCRIBED_RATE_PER_KM) * km;
      base.km = km;
      base.ratePerKm = rate;
      base.taxablePortion = Number(taxable.toFixed(2));
      base.nonTaxablePortion = Number(nonTaxable.toFixed(2));
      base.value = Number((km * rate).toFixed(2));
    } else {
      const v = Number(draft.value);
      if (!Number.isFinite(v) || v <= 0) return null;
      base.value = v;
    }
    return base;
  }

  async function saveDrafts(): Promise<void> {
    const payloads = drafts.map(buildLinePayload).filter((p): p is Record<string, unknown> => p !== null);
    if (payloads.length === 0) {
      setError('Fill at least one row (employee + value or km/rate)');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await apiFetch(`/api/payroll/batches/${id}/lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: payloads }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? json.message ?? 'Save failed');
        return;
      }
      setDrafts([emptyDraft]);
      setMessage(`Saved ${payloads.length} line(s)`);
      await load();
    } catch {
      setError('Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(lineId: string): Promise<void> {
    if (!confirm('Remove this line?')) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/payroll/batches/${id}/lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: [{
            employeeId: lines.find(l => l.id === lineId)?.employeeId,
            value: 0,
            effectiveFrom: defaultEffectiveFrom,
          }],
        }),
      });
      if (!res.ok) {
        setError('Remove failed');
      } else {
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function runValidate(): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await apiFetch(`/api/payroll/batches/${id}/validate`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? json.message ?? 'Validate failed');
        return;
      }
      const payload = (json.data ?? json) as { ok: boolean; errors: unknown[]; totalLines: number };
      if (payload.ok) setMessage(`Validated — ${payload.totalLines} line(s) clean`);
      else setError(`${payload.errors.length} line(s) have errors`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function runPost(): Promise<void> {
    if (!confirm('Post this batch into payroll? This cannot be undone.')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await apiFetch(`/api/payroll/batches/${id}/post`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? json.message ?? 'Post failed');
        return;
      }
      const payload = (json.data ?? json) as { inserted: number };
      setMessage(`Posted — ${payload.inserted} component assignment(s) created`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
        </div>
      </AppLayout>
    );
  }

  if (!batch) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center gap-2 text-red-400 py-12">
          <AlertCircle className="h-5 w-5" /><span>{error || 'Batch not found'}</span>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/payroll/batches" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-indigo-500/10">
              <Layers className="h-6 w-6 text-indigo-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">{batch.description}</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                {batch.batchType === 'reimbursive_travel' ? 'Reimbursive travel' : 'Component values'}
                {' · '}{batch.periodMonth}/{batch.periodYear}
                {' · '}{batch.status}
                {' · '}{batch.lineCount} line(s) · {formatCurrency(batch.totalAmount)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isEditable && (
              <button onClick={runValidate} disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50">
                <CheckCircle2 className="h-4 w-4" /> Validate
              </button>
            )}
            {batch.status === 'validated' && (
              <button onClick={runPost} disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50">
                <Send className="h-4 w-4" /> Post
              </button>
            )}
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg p-3"><AlertCircle className="h-4 w-4" />{error}</div>}
          {message && <div className="flex items-center gap-2 text-sm text-emerald-400 bg-emerald-500/10 rounded-lg p-3"><CheckCircle2 className="h-4 w-4" />{message}</div>}

          <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                  <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Employee</th>
                  {batch.batchType === 'reimbursive_travel' ? (
                    <>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">km</th>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Rate/km</th>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">3703 (non-tax)</th>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">3702 (tax)</th>
                    </>
                  ) : (
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Amount</th>
                  )}
                  <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                    <td className="py-2 px-3 text-[var(--ff-text-primary)]">
                      {l.employeeNumber} — {l.employeeName}
                    </td>
                    {batch.batchType === 'reimbursive_travel' ? (
                      <>
                        <td className="py-2 px-3 text-right font-mono">{l.km ?? '—'}</td>
                        <td className="py-2 px-3 text-right font-mono">{l.ratePerKm ?? '—'}</td>
                        <td className="py-2 px-3 text-right font-mono">{formatCurrency(l.nonTaxablePortion ?? 0)}</td>
                        <td className="py-2 px-3 text-right font-mono">{formatCurrency(l.taxablePortion ?? 0)}</td>
                      </>
                    ) : (
                      <td className="py-2 px-3 text-right font-mono">{formatCurrency(l.value)}</td>
                    )}
                    <td className="py-2 px-3 text-xs text-red-400">{l.error ?? ''}</td>
                    <td className="py-2 px-3 text-right">
                      {isEditable && (
                        <button onClick={() => removeLine(l.id)} disabled={busy}
                          className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]">
                          <Trash2 className="h-4 w-4 text-red-400" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={batch.batchType === 'reimbursive_travel' ? 6 : 3} className="py-6 text-center text-[var(--ff-text-secondary)] text-sm">
                      No lines yet — add some below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {isEditable && (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-[var(--ff-text-primary)]">Add rows</div>
                <button onClick={addDraftRow} className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
                  <Plus className="h-3 w-3" /> Another row
                </button>
              </div>
              {drafts.map((d, i) => (
                <div key={i} className="grid gap-2" style={{ gridTemplateColumns: batch.batchType === 'reimbursive_travel' ? '2fr 1fr 1fr auto' : '2fr 1fr auto' }}>
                  <select value={d.employeeId} onChange={e => updateDraft(i, { employeeId: e.target.value })}
                    className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-2 py-1 text-[var(--ff-text-primary)]">
                    <option value="">Select employee</option>
                    {availableEmployees.map(e => (
                      <option key={e.id} value={e.id}>{e.employeeNumber} — {e.firstName} {e.lastName}</option>
                    ))}
                  </select>
                  {batch.batchType === 'reimbursive_travel' ? (
                    <>
                      <input type="number" step="0.01" placeholder="km" value={d.km} onChange={e => updateDraft(i, { km: e.target.value })}
                        className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-2 py-1 text-[var(--ff-text-primary)]" />
                      <input type="number" step="0.01" placeholder="R/km" value={d.ratePerKm} onChange={e => updateDraft(i, { ratePerKm: e.target.value })}
                        className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-2 py-1 text-[var(--ff-text-primary)]" />
                    </>
                  ) : (
                    <input type="number" step="0.01" placeholder="Amount" value={d.value} onChange={e => updateDraft(i, { value: e.target.value })}
                      className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-2 py-1 text-[var(--ff-text-primary)]" />
                  )}
                  <button type="button" onClick={() => removeDraft(i)} disabled={drafts.length === 1}
                    className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-30">
                    <Trash2 className="h-4 w-4 text-red-400" />
                  </button>
                </div>
              ))}
              <div className="flex justify-end pt-1">
                <button onClick={saveDrafts} disabled={busy}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-50">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add to batch
                </button>
              </div>
              {batch.batchType === 'reimbursive_travel' && (
                <p className="text-xs text-[var(--ff-text-secondary)]">
                  Split is calculated client-side against SARS prescribed rate R{SARS_PRESCRIBED_RATE_PER_KM}/km.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
