/**
 * Admin Data Migration Tool
 * Bulk CSV upload for accounts, customers, and suppliers — any company.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Upload, CheckCircle2, AlertCircle, Loader2, Database, Play } from 'lucide-react';

type Source   = 'xero' | 'quickbooks' | 'pastel';
type FileType = 'accounts' | 'customers' | 'suppliers';
type ZoneStatus = 'idle' | 'uploading' | 'parsed' | 'error';

interface Company { id: string; name: string; trading_name: string | null }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ZoneState { status: ZoneStatus; count: number; error: string; parsed: any[] }
interface ExecResult {
  accounts?:  { succeeded: number; failed: number };
  customers?: { succeeded: number; failed: number };
  suppliers?: { succeeded: number; failed: number };
}

const BLANK: ZoneState = { status: 'idle', count: 0, error: '', parsed: [] };

const SOURCES: { value: Source; label: string }[] = [
  { value: 'xero',       label: 'Xero' },
  { value: 'quickbooks', label: 'QuickBooks' },
  { value: 'pastel',     label: 'Sage / Pastel' },
];

const ZONES: { type: FileType; label: string }[] = [
  { type: 'accounts',  label: 'Chart of Accounts' },
  { type: 'customers', label: 'Customers' },
  { type: 'suppliers', label: 'Suppliers' },
];

function zoneCls(s: ZoneStatus) {
  if (s === 'parsed')    return 'border-teal-500 bg-teal-500/5';
  if (s === 'error')     return 'border-red-400 bg-red-500/5';
  if (s === 'uploading') return 'border-teal-300 bg-teal-400/5';
  return 'border-gray-300 dark:border-gray-600 hover:border-teal-400';
}

export default function AdminMigrationsPage() {
  const [companies, setCompanies]   = useState<Company[]>([]);
  const [loadingCo, setLoadingCo]   = useState(true);
  const [companyId, setCompanyId]   = useState('');
  const [source, setSource]         = useState<Source>('xero');
  const [zones, setZones]           = useState<Record<FileType, ZoneState>>({
    accounts: { ...BLANK }, customers: { ...BLANK }, suppliers: { ...BLANK },
  });
  const [executing, setExecuting]   = useState(false);
  const [result, setResult]         = useState<ExecResult | null>(null);
  const [execErr, setExecErr]       = useState('');

  const refs = {
    accounts:  useRef<HTMLInputElement>(null),
    customers: useRef<HTMLInputElement>(null),
    suppliers: useRef<HTMLInputElement>(null),
  };

  const patch = (t: FileType, p: Partial<ZoneState>) =>
    setZones(prev => ({ ...prev, [t]: { ...prev[t], ...p } }));

  const loadCompanies = useCallback(async () => {
    setLoadingCo(true);
    try {
      const res  = await apiFetch('/api/admin/companies?limit=200&sort_by=name&sort_dir=asc');
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      const items: Company[] = (json.data?.items ?? []).map((c: Company) =>
        ({ id: c.id, name: c.name, trading_name: c.trading_name }));
      setCompanies(items);
      if (items.length > 0 && items[0]) setCompanyId(items[0].id);
    } catch (err) {
      log.error('Failed to load companies for migration tool', { error: err }, 'admin-ui');
    } finally { setLoadingCo(false); }
  }, []);

  useEffect(() => { void loadCompanies(); }, [loadCompanies]);

  // Reset zones when source changes
  useEffect(() => {
    setZones({ accounts: { ...BLANK }, customers: { ...BLANK }, suppliers: { ...BLANK } });
    setResult(null);
    setExecErr('');
  }, [source]);

  const handleFile = async (file: File, type: FileType) => {
    if (!companyId) return;
    patch(type, { status: 'uploading', error: '', count: 0, parsed: [] });
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('source', source);
      fd.append('fileType', type);
      // withAuth middleware reads X-Company-Id header — pass the admin-selected company explicitly
      const res  = await apiFetch('/api/accounting/migration-parse', {
        method: 'POST',
        headers: { 'X-Company-Id': companyId },
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Parse failed');
      patch(type, { status: 'parsed', count: json.data?.count ?? 0, parsed: json.data?.parsed ?? [] });
    } catch (err) {
      patch(type, { status: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
    }
  };

  const handleExecute = async () => {
    if (!companyId) return;
    setExecuting(true); setExecErr(''); setResult(null);
    try {
      // withAuth middleware reads X-Company-Id header — pass the admin-selected company explicitly
      const res  = await apiFetch('/api/accounting/migration-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Company-Id': companyId },
        body: JSON.stringify({ source, accounts: zones.accounts.parsed, customers: zones.customers.parsed, suppliers: zones.suppliers.parsed }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Migration failed');
      setResult(json.data as ExecResult);
    } catch (err) {
      setExecErr(err instanceof Error ? err.message : 'Migration failed');
    } finally { setExecuting(false); }
  };

  const anyParsed  = Object.values(zones).some(z => z.status === 'parsed');
  const totalCount = Object.values(zones).reduce((s, z) => s + z.count, 0);
  const companyName = companies.find(c => c.id === companyId);

  const selectCls = 'w-full text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-teal-500 focus:border-transparent';

  return (
    <AdminLayout title="Data Migration">
      <div className="max-w-3xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-2 bg-teal-500/10 rounded-lg">
            <Database className="w-5 h-5 text-teal-600 dark:text-teal-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Data Migration</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Upload CSV files to migrate data into any company account.
            </p>
          </div>
        </div>

        {/* Step 1 — Company + Source */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 space-y-4">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">1. Target &amp; Source</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Company</label>
              {loadingCo ? (
                <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading&hellip;</div>
              ) : (
                <select value={companyId} onChange={e => setCompanyId(e.target.value)} className={selectCls}>
                  {!companies.length && <option value="">No companies found</option>}
                  {companies.map(c => <option key={c.id} value={c.id}>{c.trading_name ?? c.name}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Source System</label>
              <select value={source} onChange={e => setSource(e.target.value as Source)} className={selectCls}>
                {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Step 2 — Upload zones */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 space-y-3">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">2. Upload CSV Files</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {ZONES.map(({ type, label }) => {
              const z = zones[type];
              return (
                <div key={type}>
                  <input ref={refs[type]} type="file" accept=".csv,.xlsx" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f, type); e.target.value = ''; }} />
                  <button type="button" disabled={!companyId || z.status === 'uploading'}
                    onClick={() => refs[type].current?.click()}
                    className={`w-full flex flex-col items-center gap-2 p-4 border-2 border-dashed rounded-xl transition-colors text-center disabled:opacity-50 disabled:cursor-not-allowed ${zoneCls(z.status)}`}>
                    {z.status === 'uploading' ? <Loader2 className="w-5 h-5 animate-spin text-teal-500" />
                      : z.status === 'parsed'  ? <CheckCircle2 className="w-5 h-5 text-teal-500" />
                      : z.status === 'error'   ? <AlertCircle className="w-5 h-5 text-red-500" />
                      : <Upload className="w-5 h-5 text-gray-600 dark:text-gray-400" />}
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
                    {z.status === 'idle'      && <span className="text-xs text-gray-600 dark:text-gray-400">.csv / .xlsx</span>}
                    {z.status === 'uploading' && <span className="text-xs text-teal-500">Parsing&hellip;</span>}
                    {z.status === 'parsed'    && <span className="text-xs font-semibold text-teal-600 dark:text-teal-400">{z.count} records</span>}
                    {z.status === 'error'     && <span className="text-xs text-red-500 line-clamp-2">{z.error}</span>}
                  </button>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400">Files are parsed client-side — no data saved until you execute below.</p>
        </div>

        {/* Step 3 — Summary + Execute */}
        {anyParsed && (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 space-y-4">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">3. Review &amp; Execute</p>
            <div className="grid grid-cols-3 gap-3 text-center">
              {ZONES.map(({ type, label }) => (
                <div key={type} className="bg-gray-50 dark:bg-gray-700/40 rounded-lg py-3">
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{zones[type].count}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{label}</p>
                </div>
              ))}
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <strong className="text-gray-900 dark:text-white">{totalCount} records</strong> will be imported into{' '}
              <strong className="text-gray-900 dark:text-white">{companyName?.trading_name ?? companyName?.name ?? 'selected company'}</strong>.
            </p>
            {execErr && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />{execErr}
              </div>
            )}
            <button type="button" onClick={handleExecute} disabled={executing}
              className="flex items-center gap-2 px-5 py-2.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors">
              {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {executing ? 'Running\u2026' : 'Execute Migration'}
            </button>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-teal-600 dark:text-teal-400" />
              <p className="text-sm font-semibold text-teal-900 dark:text-teal-200">Migration complete</p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center text-sm">
              {ZONES.map(({ type, label }) => {
                const r = result[type];
                if (!r) return <div key={type} className="bg-white dark:bg-gray-800 rounded-lg py-3 px-2 text-gray-600 dark:text-gray-400 text-xs">{label}<br />not imported</div>;
                return (
                  <div key={type} className="bg-white dark:bg-gray-800 rounded-lg py-3 px-2">
                    <p className="font-medium text-gray-900 dark:text-white">{label}</p>
                    <p className="text-teal-600 dark:text-teal-400 mt-1">{r.succeeded} imported</p>
                    {r.failed > 0 && <p className="text-red-500 text-xs">{r.failed} failed</p>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </AdminLayout>
  );
}
