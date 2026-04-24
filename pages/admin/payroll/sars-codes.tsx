/**
 * Admin — SARS Source Codes
 *
 * Read-only browser + import wizard. SARS codes are vendor-maintained
 * reference data — there is no Add / Edit form. Codes enter via XLSX
 * import; the only mutations available here are setting the current
 * release year and toggling individual codes between active/deprecated.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  AlertCircle, Loader2, Upload, CheckCircle2, FileSpreadsheet, X,
  Search, RotateCcw, BadgeCheck, Ban, ExternalLink,
} from 'lucide-react';

interface ReleaseRow {
  effective_year: number;
  brs_version: string;
  released_at: string;
  is_current: boolean;
  notes: string | null;
  code_count: number;
}

interface CodeRow {
  code: string;
  effective_year: number;
  category: string;
  description: string;
  status: string;
  foreign_code: string | null;
  code_pair: string | null;
  applicability_note: string | null;
  source_document: string | null;
  source_url: string | null;
  official_excerpt: string | null;
  brs_version: string | null;
  imported_at: string;
  used_by_companies: number;
}

interface ImportDiff {
  added: string[];
  removed: string[];
  changed: { code: string; field: string; oldValue: string | null; newValue: string | null }[];
}

interface ImportResult {
  effectiveYear: number;
  brsVersion: string;
  upserted: number;
  diff: ImportDiff;
  setCurrent: boolean;
  rowCount?: number;
  dryRun?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  income: 'Income',
  allowance: 'Allowance',
  fringe: 'Fringe Benefit',
  employer: 'Employer Contrib.',
  deduction: 'Deduction',
  lump_sum: 'Lump Sum',
};

const STATUS_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  active:      { bg: 'bg-emerald-500/10', fg: 'text-emerald-400', label: 'Active' },
  conditional: { bg: 'bg-amber-500/10',   fg: 'text-amber-400',   label: 'Conditional' },
  deprecated:  { bg: 'bg-red-500/10',     fg: 'text-red-400',     label: 'Deprecated' },
};

export default function AdminSarsCodesPage() {
  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [taxYear, setTaxYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [drawerCode, setDrawerCode] = useState<CodeRow | null>(null);
  const [importerOpen, setImporterOpen] = useState(false);

  const load = useCallback(async (year: number | null) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (year) params.set('taxYear', String(year));
      if (search.trim()) params.set('search', search.trim());
      if (category) params.set('category', category);
      if (statusFilter) params.set('status', statusFilter);
      const res = await apiFetch(`/api/admin/payroll/sars-codes?${params.toString()}`);
      const json = await res.json() as { data?: { releases: ReleaseRow[]; codes: CodeRow[]; taxYear: number | null }; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setReleases(json.data?.releases ?? []);
      setCodes(json.data?.codes ?? []);
      setTaxYear(json.data?.taxYear ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [search, category, statusFilter]);

  useEffect(() => { void load(taxYear); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const onYearChange = (y: number) => { setTaxYear(y); void load(y); };

  const onSetCurrent = async (year: number) => {
    if (!confirm(`Mark tax year ${year} as the current SARS release? All new payroll runs will use this year's codes.`)) return;
    const res = await apiFetch('/api/admin/payroll/sars-codes/release', {
      method: 'POST',
      body: JSON.stringify({ taxYear: year }),
    });
    if (res.ok) await load(year);
    else {
      const j = await res.json().catch(() => ({}));
      alert(j.message || 'Failed to set current');
    }
  };

  const onToggleStatus = async (row: CodeRow) => {
    const next = row.status === 'deprecated' ? 'active' : 'deprecated';
    if (next === 'deprecated' && row.used_by_companies > 0) {
      if (!confirm(`Code ${row.code} is used by ${row.used_by_companies} compan${row.used_by_companies === 1 ? 'y' : 'ies'}. Marking deprecated will block new payroll runs that reference it. Continue?`)) return;
    }
    const res = await apiFetch(`/api/admin/payroll/sars-codes/${row.code}?taxYear=${row.effective_year}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) {
      if (drawerCode?.code === row.code) setDrawerCode({ ...row, status: next });
      await load(taxYear);
    } else {
      const j = await res.json().catch(() => ({}));
      alert(j.message || 'Failed to update');
    }
  };

  return (
    <AdminLayout title="SARS Source Codes">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--ff-text-primary)]">SARS Source Codes</h1>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
              Vendor-maintained reference data from the SARS PAYE-AE-06-G06 guide. Tenants pick from these codes when defining payroll components — they cannot edit them. Import a new XLSX after each annual SARS release.
            </p>
          </div>
          <button
            onClick={() => setImporterOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium"
          >
            <Upload className="h-4 w-4" /> Import XLSX
          </button>
        </div>

        {/* Releases strip */}
        <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
            <h2 className="text-sm font-medium text-[var(--ff-text-primary)]">Releases</h2>
            <span className="text-xs text-[var(--ff-text-tertiary)]">One release marked <span className="text-emerald-400">current</span> drives all new payroll runs.</span>
          </div>
          <div className="divide-y divide-[var(--ff-border-primary)]">
            {releases.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[var(--ff-text-tertiary)]">No releases yet — import the first XLSX to get started.</p>
            ) : releases.map((r) => (
              <div key={r.effective_year} className={`px-4 py-3 flex items-center gap-4 ${taxYear === r.effective_year ? 'bg-teal-500/5' : ''}`}>
                <button
                  onClick={() => onYearChange(r.effective_year)}
                  className={`text-sm font-mono ${taxYear === r.effective_year ? 'text-teal-400' : 'text-[var(--ff-text-primary)] hover:text-teal-400'}`}
                >
                  Year {r.effective_year}
                </button>
                <span className="text-xs text-[var(--ff-text-tertiary)]">BRS {r.brs_version}</span>
                <span className="text-xs text-[var(--ff-text-tertiary)]">{r.code_count} codes</span>
                {r.is_current ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400">
                    <BadgeCheck className="h-3 w-3" /> Current
                  </span>
                ) : (
                  <button
                    onClick={() => onSetCurrent(r.effective_year)}
                    className="text-xs text-[var(--ff-text-secondary)] hover:text-teal-400 underline"
                  >
                    Set as current
                  </button>
                )}
                <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">Imported {new Date(r.released_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void load(taxYear); }}
              placeholder="Search code or description…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm"
            />
          </div>
          <select value={category} onChange={(e) => { setCategory(e.target.value); void load(taxYear); }} className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm">
            <option value="">All categories</option>
            {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); void load(taxYear); }} className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="conditional">Conditional</option>
            <option value="deprecated">Deprecated</option>
          </select>
          <button
            onClick={() => { setSearch(''); setCategory(''); setStatusFilter(''); void load(taxYear); }}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-xs text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
          <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{codes.length} codes</span>
        </div>

        {/* Codes table */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                  <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Code</th>
                  <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Description</th>
                  <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Category</th>
                  <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                  <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Used by</th>
                  <th className="py-3 px-4"></th>
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => {
                  const badge = STATUS_BADGE[c.status] ?? STATUS_BADGE.active!;
                  return (
                    <tr key={c.code} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)] cursor-pointer" onClick={() => setDrawerCode(c)}>
                      <td className="py-3 px-4 font-mono text-[var(--ff-text-primary)]">{c.code}{c.foreign_code ? <span className="text-xs text-[var(--ff-text-tertiary)] ml-1">/ {c.foreign_code}</span> : null}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">{c.description}</td>
                      <td className="py-3 px-4 text-xs text-[var(--ff-text-secondary)]">{CATEGORY_LABELS[c.category] ?? c.category}</td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>{badge.label}</span>
                      </td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{c.used_by_companies}</td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); void onToggleStatus(c); }}
                          className="text-xs text-[var(--ff-text-secondary)] hover:text-red-400"
                          title={c.status === 'deprecated' ? 'Restore to active' : 'Mark deprecated'}
                        >
                          {c.status === 'deprecated' ? <BadgeCheck className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {codes.length === 0 && (
                  <tr><td colSpan={6} className="py-8 text-center text-[var(--ff-text-tertiary)]">No codes match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {drawerCode && (
        <CodeDrawer
          code={drawerCode}
          onClose={() => setDrawerCode(null)}
          onToggleStatus={() => onToggleStatus(drawerCode)}
        />
      )}

      {/* Import wizard */}
      {importerOpen && (
        <ImportWizard
          onClose={() => setImporterOpen(false)}
          onComplete={() => { setImporterOpen(false); void load(taxYear); }}
        />
      )}
    </AdminLayout>
  );
}

// ─── Detail drawer ───────────────────────────────────────────────────────────

function CodeDrawer({ code, onClose, onToggleStatus }: {
  code: CodeRow;
  onClose: () => void;
  onToggleStatus: () => void;
}) {
  const badge = STATUS_BADGE[code.status] ?? STATUS_BADGE.active!;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-xl h-full overflow-y-auto bg-[var(--ff-surface-primary)] border-l border-[var(--ff-border-primary)] shadow-xl p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="font-mono text-2xl text-[var(--ff-text-primary)]">{code.code}{code.foreign_code ? <span className="text-base text-[var(--ff-text-tertiary)] ml-2">/ {code.foreign_code}</span> : null}</div>
            <div className="text-sm text-[var(--ff-text-secondary)] mt-1">{code.description}</div>
            <div className="flex items-center gap-2 mt-2">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>{badge.label}</span>
              <span className="text-xs text-[var(--ff-text-tertiary)]">Year {code.effective_year} · BRS {code.brs_version ?? '—'}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]"><X className="h-5 w-5 text-[var(--ff-text-secondary)]" /></button>
        </div>

        <div className="space-y-4 text-sm">
          <Field label="Category">{CATEGORY_LABELS[code.category] ?? code.category}</Field>
          {code.code_pair && <Field label="Code pair">{code.code_pair}</Field>}
          {code.applicability_note && <Field label="Applicability">{code.applicability_note}</Field>}
          {code.official_excerpt && (
            <div>
              <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">Official SARS guide excerpt</div>
              <div className="text-xs text-[var(--ff-text-secondary)] whitespace-pre-wrap p-3 rounded bg-[var(--ff-bg-tertiary)] max-h-64 overflow-y-auto">
                {code.official_excerpt}
              </div>
            </div>
          )}
          {code.source_url && (
            <Field label="Source">
              <a href={code.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal-400 hover:underline break-all">
                {code.source_document ?? code.source_url} <ExternalLink className="h-3 w-3" />
              </a>
            </Field>
          )}
          <Field label="Used by">{code.used_by_companies} compan{code.used_by_companies === 1 ? 'y' : 'ies'}</Field>
        </div>

        <div className="mt-6 pt-4 border-t border-[var(--ff-border-primary)]">
          <button
            onClick={onToggleStatus}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${code.status === 'deprecated' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-red-600 hover:bg-red-700 text-white'}`}
          >
            {code.status === 'deprecated' ? <><BadgeCheck className="h-4 w-4" /> Restore to active</> : <><Ban className="h-4 w-4" /> Mark deprecated</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">{label}</div>
      <div className="text-sm text-[var(--ff-text-primary)]">{children}</div>
    </div>
  );
}

// ─── Import wizard ───────────────────────────────────────────────────────────

function ImportWizard({ onClose, onComplete }: { onClose: () => void; onComplete: () => void }) {
  const [step, setStep] = useState<'pick' | 'preview' | 'done'>('pick');
  const [taxYear, setTaxYear] = useState<number>(new Date().getFullYear() + 1);
  const [brsVersion, setBrsVersion] = useState<string>('v25.2.0');
  const [setCurrent, setSetCurrent] = useState<boolean>(true);
  const [file, setFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (dryRun: boolean) => {
    if (!file) { setError('Pick an XLSX file first'); return; }
    setWorking(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('taxYear', String(taxYear));
      fd.append('brsVersion', brsVersion);
      fd.append('setCurrent', setCurrent ? '1' : '0');
      if (dryRun) fd.append('dryRun', '1');

      const res = await apiFetch('/api/admin/payroll/sars-codes/import', { method: 'POST', body: fd });
      const json = await res.json() as { data?: ImportResult; message?: string };
      if (!res.ok) throw new Error(json.message || 'Import failed');
      setPreview(json.data ?? null);
      setStep(dryRun ? 'preview' : 'done');
      if (!dryRun) setTimeout(onComplete, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-xl bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] shadow-2xl">
        <div className="px-6 py-4 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Import SARS Codes</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]"><X className="h-5 w-5 text-[var(--ff-text-secondary)]" /></button>
        </div>

        <div className="p-6 space-y-4">
          {step === 'pick' && (
            <>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Upload the curated SARS PAYE-AE-06-G06 master XLSX (sheet <span className="font-mono">Master_Codes</span>). The 4xxx deduction/employer codes are auto-topped-up from the legacy seed if missing.
              </p>
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">Tax year</span>
                  <input type="number" value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))} className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm" />
                </label>
                <label className="block col-span-2">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">BRS version</span>
                  <input type="text" value={brsVersion} onChange={(e) => setBrsVersion(e.target.value)} placeholder="v25.2.0" className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm" />
                </label>
              </div>

              <div
                onClick={() => inputRef.current?.click()}
                className="border-2 border-dashed border-[var(--ff-border-primary)] hover:border-teal-500 rounded-lg p-8 text-center cursor-pointer"
              >
                <FileSpreadsheet className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
                <p className="text-sm text-[var(--ff-text-primary)]">{file ? file.name : 'Click to choose XLSX file'}</p>
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Max 5 MB · sheet "Master_Codes" required</p>
                <input ref={inputRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>

              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
                <input type="checkbox" checked={setCurrent} onChange={(e) => setSetCurrent(e.target.checked)} />
                Mark this release as current after import
              </label>

              {error && <div className="flex items-center gap-2 text-sm text-red-400"><AlertCircle className="h-4 w-4" /> {error}</div>}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">Cancel</button>
                <button onClick={() => submit(true)} disabled={working || !file} className="px-3 py-2 rounded-lg text-sm bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)] disabled:opacity-50">
                  {working ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Preview diff'}
                </button>
                <button onClick={() => submit(false)} disabled={working || !file} className="px-3 py-2 rounded-lg text-sm bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-50">
                  {working ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Import now'}
                </button>
              </div>
            </>
          )}

          {step === 'preview' && preview && (
            <>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Preview against year {preview.effectiveYear - 1}: <span className="text-[var(--ff-text-primary)] font-medium">{preview.rowCount ?? 0}</span> rows in file.
              </p>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <DiffCell label="Added" value={preview.diff.added.length} color="text-emerald-400" />
                <DiffCell label="Removed" value={preview.diff.removed.length} color="text-red-400" />
                <DiffCell label="Changed" value={preview.diff.changed.length} color="text-amber-400" />
              </div>
              <DiffList title="Added codes" codes={preview.diff.added} />
              <DiffList title="Removed codes" codes={preview.diff.removed} />
              {preview.diff.changed.length > 0 && (
                <div>
                  <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">Changed codes</div>
                  <div className="text-xs text-[var(--ff-text-secondary)] max-h-40 overflow-y-auto rounded bg-[var(--ff-bg-tertiary)] p-2 space-y-1">
                    {preview.diff.changed.map((c, i) => (
                      <div key={i}><span className="font-mono">{c.code}</span> {c.field}: <span className="text-red-400 line-through">{c.oldValue ?? '—'}</span> → <span className="text-emerald-400">{c.newValue ?? '—'}</span></div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => { setStep('pick'); setPreview(null); }} className="px-3 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">Back</button>
                <button onClick={() => submit(false)} disabled={working} className="px-3 py-2 rounded-lg text-sm bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-50">
                  {working ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm import'}
                </button>
              </div>
            </>
          )}

          {step === 'done' && preview && (
            <div className="text-center py-6">
              <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
              <p className="text-sm text-[var(--ff-text-primary)]">Imported {preview.upserted} codes for tax year {preview.effectiveYear} (BRS {preview.brsVersion}).</p>
              {preview.setCurrent && <p className="text-xs text-emerald-400 mt-1">Marked as current release.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg bg-[var(--ff-bg-tertiary)] p-3">
      <div className="text-xs text-[var(--ff-text-tertiary)]">{label}</div>
      <div className={`text-2xl font-mono ${color}`}>{value}</div>
    </div>
  );
}

function DiffList({ title, codes }: { title: string; codes: string[] }) {
  if (codes.length === 0) return null;
  return (
    <div>
      <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">{title}</div>
      <div className="text-xs text-[var(--ff-text-secondary)] flex flex-wrap gap-1 max-h-24 overflow-y-auto rounded bg-[var(--ff-bg-tertiary)] p-2">
        {codes.map((c) => <span key={c} className="font-mono px-1 py-0.5 rounded bg-[var(--ff-surface-primary)]">{c}</span>)}
      </div>
    </div>
  );
}
