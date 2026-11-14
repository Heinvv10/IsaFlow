/**
 * Admin Sage Auto-Import
 *
 * Pick target company → connect (extension or pasted cookie) → click
 * Pull from Sage. The target is then locked to the pulled-for company until
 * Start over (audit 3.4), and Commit confirms, naming it. The server hits Sage's API directly using the
 * supplied session cookie, maps every endpoint, and stashes the
 * mapped data so the existing commit endpoint can pick it up.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useSageExtension } from '@/hooks/useSageExtension';
import Link from 'next/link';
import { AdminLayout } from '@/components/admin/AdminLayout';
import type { SageCommitSummaryData } from '@/components/admin/SageCommitSummary';
import { INITIAL_STEPS, SageCommitPanel, SagePulledSteps, type PullStep } from '@/components/admin/sage/SageImportSteps';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { ArrowLeft, Download, CheckCircle2, AlertCircle, Loader2, Cable, KeyRound } from 'lucide-react';

interface Company { id: string; name: string }

export default function AdminSageImportPage() {
  const adminHref = useAdminHref();
  const ext = useSageExtension();

  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  /** The company the pulled data is for: set at Pull, the only target Commit uses, cleared by Start over. */
  const [pulledFor, setPulledFor] = useState<Company | null>(null);
  /** sage-pull-server's token: the server refuses a commit that is not this pull, for this company. */
  const pullToken = useRef('');
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
      .then(async r => { await assertOk(r, 'Could not load companies - try again'); return r.json(); })
      .then(d => setCompanies(d.data?.items ?? []))
      .catch((err: unknown) => setCompaniesError(apiErrorMessage(err, 'Could not load companies - try again')));
  }, []);

  const resetSteps = useCallback(() => {
    setSteps(INITIAL_STEPS.map(s => ({ ...s, status: 'pending', count: undefined })));
    pulledData.current = {};
    pullToken.current = '';
    setPulledAt(null);
    setCommitSummary(null);
    setPulledFor(null);
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
      await assertOk(res, 'Could not pull the data from Sage - try again');
      const json = await res.json();

      const pulled = json.data?.pulled ?? {};
      pulledData.current = pulled;
      pullToken.current = String(json.data?.pullToken ?? '');
      setSteps(prev => prev.map(s => ({
        ...s,
        status: 'done',
        count: pulled[s.id]?.total ?? (s.id === 'company' ? 1 : pulled[s.id]?.records?.length ?? 0),
      })));
      setPulledAt(new Date());
      setPulledFor(companies.find(c => c.id === selectedCompanyId) ?? { id: selectedCompanyId, name: selectedCompanyId });
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not pull the data from Sage - try again'));
    } finally {
      setPulling(false);
    }
  }, [selectedCompanyId, companies, resetSteps]);

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
    if (!pulledFor) return;
    const what = mode === 'namesAndCoa'
      ? 'the chart of accounts, customers and suppliers'
      : 'everything pulled (accounts, customers, suppliers and their invoices, with the invoices\' journals)';
    const dates = mode === 'all'
      ? ' Historical documents post into their original dates, including closed periods; documents that move VAT into a period with a filed VAT return are refused (per document; the rest commit).'
      : '';
    if (!confirm(`Import ${what} from Sage into ${pulledFor.name}? This writes into that company's books and cannot be undone from here.${dates}`)) return;
    setCommitting(true); setError(''); setCommitSummary(null);
    try {
      const all = pulledData.current;
      const payload = mode === 'namesAndCoa'
        ? { accounts: all.accounts, customers: all.customers, suppliers: all.suppliers }
        : all;
      const res = await apiFetch('/api/admin/migration/sage-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ companyId: pulledFor.id, pulled: payload, pullToken: pullToken.current }),
      });
      await assertOk(res, 'Could not import the Sage data - try again');
      const json = await res.json();
      setCommitSummary(json.data);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not import the Sage data - try again'));
    } finally {
      setCommitting(false);
    }
  }, [pulledFor]);

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
                Pull data from Sage Business Cloud into an IsaFlow company.
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
            Select the IsaFlow company that Sage data will be imported into.
          </p>
          {companiesError ? (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" /> {companiesError}
            </div>
          ) : (
            <select
              value={selectedCompanyId}
              onChange={e => setSelectedCompanyId(e.target.value)}
              disabled={pulling || !!pulledFor}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500"
            >
              <option value="">-- Select a company --</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {pulledFor && (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Locked to {pulledFor.name}: the pulled data is for this company.{' '}
              <button type="button" onClick={resetSteps} disabled={committing} className="text-teal-600 dark:text-teal-400 underline">
                Start over
              </button>{' '}to pick another (discards the pulled data).
            </p>
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
                IsaFlow Sage Connector extension detected{ext.version ? ` (v${ext.version})` : ''}.
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Make sure you are signed in to <a href="https://accounting.sageone.co.za" target="_blank" rel="noreferrer" className="text-teal-500 underline">accounting.sageone.co.za</a> in this browser, with the company you want to pull from selected.
              </p>
              <button
                onClick={() => void pullViaExtension()}
                disabled={!selectedCompanyId || pulling}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 disabled:bg-teal-800 disabled:text-teal-300 text-white rounded-lg text-sm font-semibold transition-colors"
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
                  <p className="font-medium">IsaFlow Sage Connector extension not detected.</p>
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

        <SagePulledSteps steps={steps} pulling={pulling} pulledAt={pulledAt} />

        {anyPulled && <SageCommitPanel summary={commitSummary} committing={committing} onCommit={(mode) => void commit(mode)} />}
      </div>
    </AdminLayout>
  );
}
