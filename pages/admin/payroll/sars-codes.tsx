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
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { AlertCircle, Loader2, Upload, BadgeCheck, Ban } from 'lucide-react';
import { formatDisplayDate } from '@/utils/dateFormat';
import { CodeDrawer } from '@/components/admin/payroll/SarsCodeDrawer';
import { ImportWizard } from '@/components/admin/payroll/SarsImportWizard';
import { SarsCodeFilters } from '@/components/admin/payroll/SarsCodeFilters';
import { CATEGORY_LABELS, STATUS_BADGE, type CodeRow, type ReleaseRow } from '@/components/admin/payroll/sarsCodeTypes';

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
  const didInitialLoadRef = useRef(false);

  // A filter change passes its NEW value in `next`: called in the same tick as setCategory/setStatusFilter,
  // this closure still holds the old state (audit 4.17: every filter showed the previous choice's list).
  const load = useCallback(async (year: number | null, next: { search?: string; category?: string; status?: string } = {}) => {
    setLoading(true);
    setError('');
    try {
      const q = next.search ?? search;
      const cat = next.category ?? category;
      const st = next.status ?? statusFilter;
      const params = new URLSearchParams();
      if (year) params.set('taxYear', String(year));
      if (q.trim()) params.set('search', q.trim());
      if (cat) params.set('category', cat);
      if (st) params.set('status', st);
      const res = await apiFetch(`/api/admin/payroll/sars-codes?${params.toString()}`);
      await assertOk(res, 'Could not load the SARS codes - try again');
      const json = await res.json() as { data?: { releases: ReleaseRow[]; codes: CodeRow[]; taxYear: number | null }; message?: string };
      setReleases(json.data?.releases ?? []);
      setCodes(json.data?.codes ?? []);
      setTaxYear(json.data?.taxYear ?? null);
    } catch (err) {
      setReleases([]); setCodes([]); setTaxYear(null); setError(apiErrorMessage(err, 'Could not load the SARS codes - try again'));
    } finally {
      setLoading(false);
    }
  }, [search, category, statusFilter]);

  useEffect(() => {
    if (didInitialLoadRef.current) return;
    didInitialLoadRef.current = true;
    void load(taxYear);
  }, [load, taxYear]);

  const onYearChange = (y: number) => { setTaxYear(y); void load(y); };

  const onSetCurrent = async (year: number) => {
    if (!confirm(`Mark tax year ${year} as the current SARS release? All new payroll runs will use this year's codes.`)) return;
    try {
      const res = await apiFetch('/api/admin/payroll/sars-codes/release', {
        method: 'POST',
        body: JSON.stringify({ taxYear: year }),
      });
      await assertOk(res, 'Could not set the current tax year - try again');
      await load(year);
    } catch (err) { alert(apiErrorMessage(err, 'Could not set the current tax year - try again')); }
  };

  const onToggleStatus = async (row: CodeRow) => {
    const next = row.status === 'deprecated' ? 'active' : 'deprecated';
    if (next === 'deprecated' && row.used_by_companies > 0) {
      if (!confirm(`Code ${row.code} is used by ${row.used_by_companies} compan${row.used_by_companies === 1 ? 'y' : 'ies'}. Marking deprecated will block new payroll runs that reference it. Continue?`)) return;
    }
    try {
      const res = await apiFetch(`/api/admin/payroll/sars-codes/${row.code}?taxYear=${row.effective_year}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      await assertOk(res, 'Could not update the code status - try again');
      if (drawerCode?.code === row.code) setDrawerCode({ ...row, status: next });
      await load(taxYear);
    } catch (err) {
      alert(apiErrorMessage(err, 'Could not update the code status - try again'));
    }
  };

  return (
    <AdminLayout title="SARS Source Codes" ownHeading>
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
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
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
                <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">Imported {formatDisplayDate(r.released_at)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Filter bar. A filter change passes its NEW value to load (audit 4.17). */}
        <SarsCodeFilters
          search={search}
          category={category}
          status={statusFilter}
          count={codes.length}
          onSearch={setSearch}
          onSubmitSearch={() => void load(taxYear)}
          onCategory={(v) => { setCategory(v); void load(taxYear, { category: v }); }}
          onStatus={(v) => { setStatusFilter(v); void load(taxYear, { status: v }); }}
          onReset={() => { setSearch(''); setCategory(''); setStatusFilter(''); void load(taxYear, { search: '', category: '', status: '' }); }}
        />

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
