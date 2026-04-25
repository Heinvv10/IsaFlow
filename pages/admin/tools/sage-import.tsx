/**
 * Admin Sage Auto-Import
 * Wraps the Sage import flow for admins, with a company selector.
 * Admin picks a target company, then proceeds through the same
 * connect → pull → review steps as the customer-facing page.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import {
  ArrowLeft, Download, CheckCircle2, AlertCircle,
  Loader2, Database, Users, Building2, FileText, ShieldCheck,
  ExternalLink, RefreshCw,
} from 'lucide-react';

interface Company {
  id: string;
  name: string;
}

interface PullStep {
  id: string;
  label: string;
  icon: typeof Database;
  description: string;
  status: 'pending' | 'pulling' | 'done' | 'error';
  count?: number;
  error?: string;
}

const INITIAL_STEPS: PullStep[] = [
  { id: 'company',    label: 'Company Info',           icon: Building2, description: 'Name, tax number, registration',   status: 'pending' },
  { id: 'accounts',  label: 'Chart of Accounts',       icon: Database,  description: 'All GL accounts with categories',  status: 'pending' },
  { id: 'customers', label: 'Customers',               icon: Users,     description: 'Customer contacts and balances',   status: 'pending' },
  { id: 'suppliers', label: 'Suppliers',               icon: Building2, description: 'Supplier contacts and balances',   status: 'pending' },
  { id: 'arInvoices',label: 'Customer Invoices (AR)',  icon: FileText,  description: 'Outstanding sales invoices',       status: 'pending' },
  { id: 'apInvoices',label: 'Supplier Invoices (AP)',  icon: FileText,  description: 'Outstanding purchase invoices',    status: 'pending' },
];

export default function AdminSageImportPage() {
  const adminHref = useAdminHref();

  const [companies, setCompanies]               = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [companiesError, setCompaniesError]     = useState('');

  const [steps, setSteps]       = useState<PullStep[]>(INITIAL_STEPS);
  const [connected, setConnected] = useState(false);
  const [pulling, setPulling]   = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitSummary, setCommitSummary] = useState<null | {
    accounts:   { created: number; skipped: number; failed: string[] };
    customers:  { created: number; skipped: number; failed: string[] };
    suppliers:  { created: number; skipped: number; failed: string[] };
    arInvoices: { created: number; skipped: number; failed: string[] };
    apInvoices: { created: number; skipped: number; failed: string[] };
  }>(null);
  const [error, setError]       = useState('');
  const [sageWindow, setSageWindow] = useState<Window | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pulledData = useRef<Record<string, any>>({});

  // Load companies on mount
  useEffect(() => {
    apiFetch('/api/admin/companies?limit=200')
      .then(r => r.json())
      .then(d => setCompanies(d.data?.items ?? []))
      .catch(() => setCompaniesError('Failed to load companies.'));
  }, []);

  const updateStep = useCallback((id: string, update: Partial<PullStep>) => {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...update } : s));
  }, []);

  const openSageTab = useCallback(() => {
    const win = window.open('https://accounting.sageone.co.za/Dashboard/Home.aspx', 'sage_session');
    if (win) {
      setSageWindow(win);
      setConnected(true);
      setError('');
    } else {
      setError('Popup blocked — please allow popups for this site.');
    }
  }, []);

  const runScriptInSage = useCallback(async (_script: string): Promise<unknown> => {
    return new Promise((_resolve, reject) => {
      if (!sageWindow || sageWindow.closed) {
        reject(new Error('Sage window is closed. Please reconnect.'));
        return;
      }
      // Cross-origin restriction: cannot inject JS into accounting.sageone.co.za.
      // Use the bookmarklet method below as an alternative.
      reject(new Error('Cannot access Sage window — cross-origin restriction. Use the bookmarklet method instead.'));
    });
  }, [sageWindow]);

  const pullAllData = useCallback(async () => {
    if (!selectedCompanyId) {
      setError('Please select a target company before pulling data.');
      return;
    }
    setPulling(true);
    setError('');

    try {
      const scriptsRes  = await apiFetch(`/api/admin/migration/sage-pull?companyId=${selectedCompanyId}`);
      const scriptsJson = await scriptsRes.json();
      if (!scriptsRes.ok) throw new Error('Failed to load pull scripts');
      const scripts = scriptsJson.data.scripts as Record<string, string>;

      for (const step of INITIAL_STEPS) {
        updateStep(step.id, { status: 'pulling' });
        try {
          const rawData = await runScriptInSage(scripts[step.id] || '');

          const mapRes  = await apiFetch(
            `/api/admin/migration/sage-pull?companyId=${selectedCompanyId}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ step: step.id, rawData }),
            },
          );
          const mapJson = await mapRes.json();
          if (!mapRes.ok) throw new Error(mapJson.message || 'Mapping failed');

          pulledData.current[step.id] = mapJson.data;
          updateStep(step.id, {
            status: 'done',
            count: mapJson.data.total ?? mapJson.data.records?.length ?? 1,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Pull failed';
          updateStep(step.id, { status: 'error', error: msg });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pull data');
    } finally {
      setPulling(false);
    }
  }, [selectedCompanyId, runScriptInSage, updateStep]);

  const allDone  = steps.every(s => s.status === 'done');
  const anyError = steps.some(s => s.status === 'error');
  const anyPulled = steps.some(s => s.status === 'done');

  const commit = useCallback(async (mode: 'all' | 'namesAndCoa') => {
    if (!selectedCompanyId) return;
    setCommitting(true);
    setError('');
    setCommitSummary(null);
    try {
      const all = pulledData.current;
      const payload = mode === 'namesAndCoa'
        ? { accounts: all.accounts, customers: all.customers, suppliers: all.suppliers }
        : all;
      const res = await apiFetch('/api/admin/migration/sage-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, pulled: payload }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? json.message ?? 'Commit failed');
      setCommitSummary(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  }, [selectedCompanyId]);

  const commitToIsaflow = useCallback(() => commit('all'), [commit]);
  const commitNamesAndCoaOnly = useCallback(() => commit('namesAndCoa'), [commit]);

  return (
    <AdminLayout title="Sage Auto-Import">
      <div className="max-w-3xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <Link
            href={adminHref('/admin/tools')}
            className="inline-flex items-center gap-1.5 text-sm text-teal-600 dark:text-teal-400 hover:underline mb-4"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Admin Tools
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Download className="h-6 w-6 text-teal-600 dark:text-teal-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Sage Auto-Import</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Pull data from Sage Business Cloud into an ISAFlow company.
              </p>
            </div>
          </div>
        </div>

        {/* Global error */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {/* Company Selector */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-3">Target Company</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Select the ISAFlow company that Sage data will be imported into.
          </p>

          {companiesError ? (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" /> {companiesError}
            </div>
          ) : (
            <select
              value={selectedCompanyId}
              onChange={e => setSelectedCompanyId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500"
            >
              <option value="">-- Select a company --</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
        </div>

        {/* Step 1: Connect */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-3">Step 1: Connect to Sage</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Open Sage Business Cloud in a new window. Log in and select the correct company.
            ISAFlow will read data from the active session.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={openSageTab}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium"
            >
              <ExternalLink className="h-4 w-4" />
              {connected ? 'Reconnect to Sage' : 'Open Sage'}
            </button>
            {connected && (
              <span className="flex items-center gap-1 text-sm text-teal-500">
                <CheckCircle2 className="h-4 w-4" /> Sage window open
              </span>
            )}
          </div>
        </div>

        {/* Step 2: Pull Data */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900 dark:text-white">Step 2: Pull Data</h2>
            <button
              onClick={pullAllData}
              disabled={!connected || pulling || !selectedCompanyId}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg disabled:opacity-50 text-sm font-medium"
            >
              {pulling
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
              {pulling ? 'Pulling...' : 'Pull All Data'}
            </button>
          </div>

          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {steps.map(step => {
              const Icon = step.icon;
              return (
                <div key={step.id} className="flex items-center gap-3 py-3">
                  <div className="p-1.5 rounded bg-gray-100 dark:bg-gray-700">
                    <Icon className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{step.label}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {step.status === 'error' ? step.error : step.description}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {step.status === 'pending' && (
                      <span className="text-xs text-gray-600 dark:text-gray-400">Waiting</span>
                    )}
                    {step.status === 'pulling' && (
                      <Loader2 className="h-4 w-4 animate-spin text-teal-500" />
                    )}
                    {step.status === 'done' && (
                      <span className="flex items-center gap-1 text-xs text-teal-500">
                        <CheckCircle2 className="h-4 w-4" />
                        {step.count} records
                      </span>
                    )}
                    {step.status === 'error' && (
                      <AlertCircle className="h-4 w-4 text-red-400" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Step 3: Commit */}
        {(allDone || anyPulled) && (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-teal-500" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Step 3: Commit to ISAFlow</h2>
            </div>
            {anyError && !allDone && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                Some steps failed. You can commit partial data — failed steps will be skipped.
              </p>
            )}
            {!commitSummary && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Inserts customers/suppliers and approved invoices (posting journal entries) into the target company.
                Safe to re-run: existing customers/suppliers are matched by name, duplicate invoice numbers are skipped.
              </p>
            )}

            {commitSummary && (
              <div className="space-y-2 text-sm">
                {(['accounts','customers','suppliers','arInvoices','apInvoices'] as const).map(k => (
                  <div key={k} className="flex items-center justify-between gap-4 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900/40">
                    <span className="font-medium text-gray-900 dark:text-white capitalize">{k.replace('Invoices',' Invoices')}</span>
                    <span className="text-gray-600 dark:text-gray-400">
                      <span className="text-teal-600 dark:text-teal-400">{commitSummary[k].created} created</span>
                      {' · '}
                      <span>{commitSummary[k].skipped} skipped</span>
                      {commitSummary[k].failed.length > 0 && (
                        <>
                          {' · '}
                          <span className="text-red-600 dark:text-red-400">{commitSummary[k].failed.length} failed</span>
                        </>
                      )}
                    </span>
                  </div>
                ))}
                {(['accounts','customers','suppliers','arInvoices','apInvoices'] as const).some(k => commitSummary[k].failed.length > 0) && (
                  <details className="pt-2">
                    <summary className="cursor-pointer text-xs text-red-600 dark:text-red-400">Show failures</summary>
                    <pre className="text-xs mt-2 p-3 rounded bg-red-500/5 text-red-700 dark:text-red-300 max-h-64 overflow-auto whitespace-pre-wrap">
{(['accounts','customers','suppliers','arInvoices','apInvoices'] as const)
  .flatMap(k => commitSummary[k].failed.map(f => `[${k}] ${f}`))
  .join('\n')}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => void commitNamesAndCoaOnly()}
                disabled={committing || !anyPulled}
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-900 dark:text-white rounded-lg text-sm font-medium transition-colors"
                title="Commit only Chart of Accounts, Customers and Suppliers — skip AR/AP invoices."
              >
                {committing
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Committing…</>
                  : 'Commit names + COA only'}
              </button>
              <button
                onClick={() => void commitToIsaflow()}
                disabled={committing || !anyPulled}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:text-teal-300 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {committing ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Committing…</>
                ) : commitSummary ? 'Commit again' : 'Commit everything'}
              </button>
            </div>
          </div>
        )}

        {/* Bookmarklet fallback */}
        <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-2">
            Alternative: Bookmarklet Method
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            If auto-pull fails due to browser restrictions, drag the snippet below to your
            bookmarks bar and click it while on the Sage dashboard.
          </p>
          <p className="text-xs font-mono bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 p-2 rounded break-all">
            javascript:void(fetch(&apos;/services/Account/GetWithFilter&apos;,&#123;method:&apos;POST&apos;,headers:&#123;&apos;Content-Type&apos;:&apos;application/json&apos;&#125;,body:JSON.stringify(&#123;FilterId:2,Search:&apos;&apos;,Skip:0,Take:1000&#125;)&#125;).then(r=&gt;r.json()).then(d=&gt;&#123;const b=new Blob([JSON.stringify(d)],&#123;type:&apos;application/json&apos;&#125;);const a=document.createElement(&apos;a&apos;);a.href=URL.createObjectURL(b);a.download=&apos;sage-accounts.json&apos;;a.click()&#125;))
          </p>
        </div>

      </div>
    </AdminLayout>
  );
}
