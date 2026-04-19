/**
 * UIF Declaration Page
 * Monthly UI-19 declaration to Department of Employment and Labour.
 * Route: /payroll/uif
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Loader2, AlertCircle, Plus, CheckCircle2, Clock } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const ZAR = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
type DeclarationStatus = 'draft' | 'submitted' | 'accepted';

interface UifDeclaration {
  id: string;
  periodYear: number;
  periodMonth: number;
  totalEmployees: number;
  totalLeviableSalary: number;
  totalEmployeeContribution: number;
  totalEmployerContribution: number;
  totalUif: number;
  status: DeclarationStatus;
  submittedAt: string | null;
}

const STATUS_COLOURS: Record<DeclarationStatus, string> = {
  draft: 'bg-yellow-500/20 text-yellow-400',
  submitted: 'bg-blue-500/20 text-blue-400',
  accepted: 'bg-teal-500/20 text-teal-400',
};
const STATUS_LABELS: Record<DeclarationStatus, string> = {
  draft: 'Draft', submitted: 'Submitted', accepted: 'Accepted',
};

function StatusBadge({ status }: { status: DeclarationStatus }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

interface GenerateModalProps {
  yearOptions: number[];
  onClose: () => void;
  onGenerated: () => void;
}
function GenerateModal({ yearOptions, onClose, onGenerated }: GenerateModalProps) {
  const [genYear, setGenYear] = useState(yearOptions[0] ?? new Date().getFullYear());
  const [genMonth, setGenMonth] = useState(new Date().getMonth() + 1);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  async function handleGenerate() {
    setIsGenerating(true);
    setGenerateError('');
    try {
      const res = await apiFetch('/api/payroll/uif', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: genYear, month: genMonth }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`);
      }
      onGenerated();
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : 'Failed to generate');
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] rounded-xl p-6 w-full max-w-sm shadow-xl">
        <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Generate UIF Declaration</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Year</label>
            <select value={genYear} onChange={e => setGenYear(Number(e.target.value))}
              className="w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500">
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Month</label>
            <select value={genMonth} onChange={e => setGenMonth(Number(e.target.value))}
              className="w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500">
              {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
          </div>
          {generateError && <p className="text-xs text-red-400">{generateError}</p>}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] text-sm hover:bg-[var(--ff-bg-tertiary)] transition-colors">
            Cancel
          </button>
          <button onClick={handleGenerate} disabled={isGenerating}
            className="flex-1 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors inline-flex items-center justify-center gap-2">
            {isGenerating && <Loader2 className="h-4 w-4 animate-spin" />}
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}

function currentYear() { return new Date().getFullYear(); }

export default function UifDeclarationPage() {
  const [declarations, setDeclarations] = useState<UifDeclaration[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [yearFilter, setYearFilter] = useState<number>(currentYear());
  const [showGenerate, setShowGenerate] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const yearOptions = [currentYear(), currentYear() - 1, currentYear() - 2];

  const loadDeclarations = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/uif?year=${yearFilter}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const payload = json.data ?? json;
      setDeclarations((payload ?? []) as UifDeclaration[]);
    } catch {
      setError('Failed to load UIF declarations');
    } finally {
      setIsLoading(false);
    }
  }, [yearFilter]);

  useEffect(() => { loadDeclarations(); }, [loadDeclarations]);

  async function handleMarkSubmitted(id: string) {
    setSubmittingId(id);
    try {
      const res = await apiFetch(`/api/payroll/uif/${id}`, { method: 'PATCH' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadDeclarations();
    } catch { /* user sees status unchanged */ } finally {
      setSubmittingId(null);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <FileText className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">UIF Declaration</h1>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Monthly UI-19 declaration to Department of Labour</p>
              </div>
            </div>
            <button onClick={() => setShowGenerate(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors">
              <Plus className="h-4 w-4" />Generate Declaration
            </button>
          </div>
        </div>

        {showGenerate && (
          <GenerateModal
            yearOptions={yearOptions}
            onClose={() => setShowGenerate(false)}
            onGenerated={() => { setShowGenerate(false); void loadDeclarations(); }}
          />
        )}

        <div className="px-6 py-6">
          <div className="flex items-center gap-3 mb-6">
            <select value={yearFilter} onChange={e => setYearFilter(Number(e.target.value))}
              className="py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500">
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">
                {declarations.length} declaration{declarations.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : declarations.length === 0 ? (
            <div className="text-center py-16">
              <FileText className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No UIF declarations</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Generate your first monthly UIF declaration to get started</p>
              <button onClick={() => setShowGenerate(true)}
                className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors">
                <Plus className="h-4 w-4" />Generate Declaration
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    {['Period','Employees','Leviable Salary','Employee 1%','Employer 1%','Total UIF','Status','Action'].map(h => (
                      <th key={h} className={`py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase ${h === 'Period' || h === 'Status' || h === 'Action' ? 'text-left' : 'text-right'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {declarations.map(d => (
                    <tr key={d.id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-teal-500/[0.04] transition-colors">
                      <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)]">
                        {MONTHS[(d.periodMonth - 1) % 12]} {d.periodYear}
                      </td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{d.totalEmployees}</td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{ZAR.format(d.totalLeviableSalary)}</td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{ZAR.format(d.totalEmployeeContribution)}</td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{ZAR.format(d.totalEmployerContribution)}</td>
                      <td className="py-3 px-4 text-right font-semibold text-[var(--ff-text-primary)]">{ZAR.format(d.totalUif)}</td>
                      <td className="py-3 px-4"><StatusBadge status={d.status} /></td>
                      <td className="py-3 px-4 text-right">
                        {d.status === 'draft' ? (
                          <button onClick={() => handleMarkSubmitted(d.id)} disabled={submittingId === d.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] text-xs font-medium transition-colors disabled:opacity-50">
                            {submittingId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                            Mark Submitted
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--ff-text-tertiary)]">
                            <Clock className="h-3 w-3" />
                            {d.submittedAt ? new Date(d.submittedAt).toLocaleDateString('en-ZA') : '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
