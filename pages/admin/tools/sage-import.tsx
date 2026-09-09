/**
 * Admin Sage Auto-Import
 *
 * Pick target company → connect (extension or pasted cookie) → click
 * Pull from Sage. The server hits Sage's API directly using the
 * supplied session cookie, maps every endpoint, and stashes the
 * mapped data so the existing commit endpoint can pick it up.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { SageCommitSummary, type SageCommitSummaryData } from '@/components/admin/SageCommitSummary';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { apiFetch } from '@/lib/apiFetch';
import {
  ArrowLeft, Download, CheckCircle2, AlertCircle, Loader2,
  Database, Users, Building2, FileText, ShieldCheck, Cable, KeyRound,
} from 'lucide-react';

interface Company { id: string; name: string }

type StepId = 'company' | 'accounts' | 'customers' | 'suppliers' | 'arInvoices' | 'apInvoices';
type StepStatus = 'pending' | 'done';
interface PullStep {
  id: StepId;
  label: string;
  icon: typeof Database;
  description: string;
  status: StepStatus;
  count?: number;
}

const INITIAL_STEPS: PullStep[] = [
  { id: 'company',    label: 'Company Info',           icon: Building2, description: 'Name, tax number, registration',   status: 'pending' },
  { id: 'accounts',   label: 'Chart of Accounts',      icon: Database,  description: 'All GL accounts with categories',  status: 'pending' },
  { id: 'customers',  label: 'Customers',              icon: Users,     description: 'Customer contacts and balances',   status: 'pending' },
  { id: 'suppliers',  label: 'Suppliers',              icon: Building2, description: 'Supplier contacts and balances',   status: 'pending' },
  { id: 'arInvoices', label: 'Customer Invoices (AR)', icon: FileText,  description: 'Outstanding sales invoices',       status: 'pending' },
  { id: 'apInvoices', label: 'Supplier Invoices (AP)', icon: FileText,  description: 'Outstanding purchase invoices',    status: 'pending' },
];

interface ExtensionReply {
  ok: boolean;
  error?: string | null;
  value?: string;
  names?: string[];
  count?: number;
  version?: string;
}

function useSageExtension() {
  const [installed, setInstalled] = useState(false);
  const [version, setVersion] = useState('');
  const pendingRef = useRef<Map<string, (r: ExtensionReply) => void>>(new Map());

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const d = ev.data;
      if (!d || typeof d !== 'object' || d.source !== 'isaflow-sage-extension') return;
      if (d.type === 'announce') {
        setInstalled(true);
        if (d.version) setVersion(d.version);
        return;
      }
      if (typeof d.requestId === 'string' && d.type?.endsWith?.('-reply')) {
        const cb = pendingRef.current.get(d.requestId);
        if (cb) {
          pendingRef.current.delete(d.requestId);
          cb(d as ExtensionReply);
        }
      }
    }
    window.addEventListener('message', onMessage);
    // Active probe in case the extension's announce fired before this hook mounted.
    window.postMessage({ source: 'isaflow-sage-page', type: 'isaflow-sage-ext-ping', requestId: 'probe-' + Date.now() }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const ask = useCallback((type: string, timeoutMs = 4000): Promise<ExtensionReply> => {
    return new Promise((resolve) => {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        if (pendingRef.current.delete(requestId)) {
          resolve({ ok: false, error: 'Extension did not respond' });
        }
      }, timeoutMs);
      pendingRef.current.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
      window.postMessage({ source: 'isaflow-sage-page', type, requestId }, '*');
    });
  }, []);

  return { installed, version, ask };
}

export default function AdminSageImportPage() {
  const adminHref = useAdminHref();
  const ext = useSageExtension();

  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [companiesError, setCompaniesError] = useState('');

  const [steps, setSteps] = useState<PullStep[]>(INITIAL_STEPS);
  const [pulling, setPulling] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [pulledAt, setPulledAt] = useState<Date | null>(null);
  const [commitSummary, setCommitSummary] = useState<SageCommitSummaryData | null>(null);
  const [error, setError] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [pastedCookie, setPastedCookie] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pulledData = useRef<Record<string, any>>({});

  useEffect(() => {
    apiFetch('/api/admin/companies?limit=200')
      .then(r => r.json())
      .then(d => setCompanies(d.data?.items ?? []))
      .catch(() => setCompaniesError('Failed to load companies.'));
  }, []);

  const resetSteps = useCallback(() => {
    setSteps(INITIAL_STEPS.map(s => ({ ...s, status: 'pending', count: undefined })));
    pulledData.current = {};
    setPulledAt(null);
    setCommitSummary(null);
  }, []);

  const runPull = useCallback(async (sageCookie: string) => {
    if (!selectedCompanyId) { setError('Pick a target company first.'); return; }
    if (!sageCookie || sageCookie.length < 16) { setError('Sage session cookie is missing or too short.'); return; }
    setPulling(true); setError(''); resetSteps();

    try {
      const res = await apiFetch('/api/admin/migration/sage-pull-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ companyId: selectedCompanyId, sageCookie }),
      });
      const json = await res.json();
      if (!res.ok) {
        const msg =
          (typeof json.error === 'string' && json.error) ||
          json.error?.message ||
          json.message ||
          `Pull failed (${res.status})`;
        throw new Error(msg);
      }

      const pulled = json.data?.pulled ?? {};
      pulledData.current = pulled;
      setSteps(prev => prev.map(s => ({
        ...s,
        status: 'done',
        count: pulled[s.id]?.total ?? (s.id === 'company' ? 1 : pulled[s.id]?.records?.length ?? 0),
      })));
      setPulledAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setPulling(false);
    }
  }, [selectedCompanyId, resetSteps]);

  const pullViaExtension = useCallback(async () => {
    setError('');
    const reply = await ext.ask('isaflow-sage-ext-getCookie', 6000);
    if (!reply.ok || !reply.value) {
      setError(reply.error || 'Extension could not read the Sage session cookies. Make sure you are signed in to accounting.sageone.co.za in this browser.');
      return;
    }
    await runPull(reply.value);
  }, [ext, runPull]);

  const pullViaPaste = useCallback(async () => {
    await runPull(pastedCookie.trim());
  }, [pastedCookie, runPull]);

  const commit = useCallback(async (mode: 'all' | 'namesAndCoa') => {
    if (!selectedCompanyId) return;
    setCommitting(true); setError(''); setCommitSummary(null);
    try {
      const all = pulledData.current;
      const payload = mode === 'namesAndCoa'
        ? { accounts: all.accounts, customers: all.customers, suppliers: all.suppliers }
        : all;
      const res = await apiFetch('/api/admin/migration/sage-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
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

  const anyPulled = steps.some(s => s.status === 'done');

  return (
    <AdminLayout title="Sage Auto-Import">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <Link href={adminHref('/admin/tools')} className="inline-flex items-center gap-1.5 text-sm text-teal-600 dark:text-teal-400 hover:underline mb-4">
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

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" /> <span>{error}</span>
          </div>
        )}

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
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Cable className="h-5 w-5 text-teal-500" />
            <h2 className="font-semibold text-gray-900 dark:text-white">Step 1: Connect to Sage</h2>
          </div>

          {ext.installed ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-teal-600 dark:text-teal-400">
                <CheckCircle2 className="h-4 w-4" />
                ISAFlow Sage Connector extension detected{ext.version ? ` (v${ext.version})` : ''}.
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Make sure you are signed in to <a href="https://accounting.sageone.co.za" target="_blank" rel="noreferrer" className="text-teal-500 underline">accounting.sageone.co.za</a> in this browser, with the company you want to pull from selected.
              </p>
              <button
                onClick={() => void pullViaExtension()}
                disabled={!selectedCompanyId || pulling}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:text-teal-300 text-white rounded-lg text-sm font-semibold transition-colors"
              >
                {pulling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {pulling ? 'Pulling from Sage…' : 'Pull from Sage'}
              </button>
              <button
                onClick={() => setShowPaste(v => !v)}
                className="block text-xs text-gray-500 dark:text-gray-400 underline hover:text-teal-500"
              >
                {showPaste ? 'Hide manual cookie paste' : 'Use manual cookie paste instead'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 text-sm">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">ISAFlow Sage Connector extension not detected.</p>
                  <p className="text-xs mt-1 opacity-90">
                    Install it to pull automatically: clone the repo, then in Chrome go to <code>chrome://extensions</code>, enable Developer mode, and load <code>chrome-extension/sage-connector/</code>. Reload this page after installing. Or use manual cookie paste below.
                  </p>
                </div>
              </div>
            </div>
          )}

          {(showPaste || !ext.installed) && (
            <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-700">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                <KeyRound className="h-4 w-4" /> Manual cookie paste (fallback)
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                In Chrome on the Sage tab, open DevTools → Application → Cookies → <code>https://accounting.sageone.co.za</code> → copy the value of <code>.AspNet.ApplicationCookie</code> and paste it below.
              </p>
              <textarea
                value={pastedCookie}
                onChange={e => setPastedCookie(e.target.value)}
                placeholder=".AspNet.ApplicationCookie value…"
                rows={3}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-xs font-mono px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <button
                onClick={() => void pullViaPaste()}
                disabled={!selectedCompanyId || pulling || pastedCookie.trim().length < 16}
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-900 dark:text-white rounded-lg text-sm font-medium"
              >
                {pulling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {pulling ? 'Pulling…' : 'Pull from Sage with pasted cookie'}
              </button>
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-900 dark:text-white">Step 2: Pulled Data</h2>
            {pulledAt && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Pulled {pulledAt.toLocaleTimeString()}
              </p>
            )}
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
                    <p className="text-xs text-gray-500 dark:text-gray-400">{step.description}</p>
                  </div>
                  <div className="shrink-0">
                    {pulling && step.status === 'pending' ? (
                      <Loader2 className="h-4 w-4 animate-spin text-teal-500" />
                    ) : step.status === 'done' ? (
                      <span className="flex items-center gap-1 text-xs text-teal-500">
                        <CheckCircle2 className="h-4 w-4" /> {step.count ?? 0}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500 dark:text-gray-400">Waiting</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {anyPulled && (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-teal-500" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Step 3: Commit to ISAFlow</h2>
            </div>
            {!commitSummary && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Existing customers/suppliers are matched by name; duplicate invoice numbers are skipped; existing GL accounts are skipped on conflict (account_code).
              </p>
            )}

            {commitSummary && <SageCommitSummary summary={commitSummary} />}

            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => void commit('namesAndCoa')}
                disabled={committing || !anyPulled}
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-900 dark:text-white rounded-lg text-sm font-medium transition-colors"
                title="Commit only Chart of Accounts, Customers and Suppliers — skip AR/AP invoices."
              >
                {committing ? <><Loader2 className="h-4 w-4 animate-spin" /> Committing…</> : 'Commit names + COA only'}
              </button>
              <button
                onClick={() => void commit('all')}
                disabled={committing || !anyPulled}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:text-teal-300 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {committing ? <><Loader2 className="h-4 w-4 animate-spin" /> Committing…</> : commitSummary ? 'Commit again' : 'Commit everything'}
              </button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
