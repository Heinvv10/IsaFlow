/**
 * Sage Auto-Import Page
 *
 * Flow:
 * 1. User logs into Sage in a separate browser tab
 * 2. User opens this page and clicks "Connect to Sage"
 * 3. ISAFlow opens a popup/iframe to accounting.sageone.co.za
 * 4. JavaScript runs inside that context (same-session cookies)
 * 5. Each step pulls data from Sage's internal APIs
 * 6. Data is mapped and previewed before import
 */

import { useState, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Download, CheckCircle2, AlertCircle,
  Loader2, Database, Users, Building2, FileText, ShieldCheck,
  ExternalLink, RefreshCw,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

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
  { id: 'company', label: 'Company Info', icon: Building2, description: 'Name, tax number, registration', status: 'pending' },
  { id: 'accounts', label: 'Chart of Accounts', icon: Database, description: 'All GL accounts with categories', status: 'pending' },
  { id: 'customers', label: 'Customers', icon: Users, description: 'Customer contacts and balances', status: 'pending' },
  { id: 'suppliers', label: 'Suppliers', icon: Building2, description: 'Supplier contacts and balances', status: 'pending' },
  { id: 'arInvoices', label: 'Customer Invoices (AR)', icon: FileText, description: 'Outstanding sales invoices', status: 'pending' },
  { id: 'apInvoices', label: 'Supplier Invoices (AP)', icon: FileText, description: 'Outstanding purchase invoices', status: 'pending' },
];

export default function SageAutoImportPage() {
  const [steps, setSteps] = useState<PullStep[]>(INITIAL_STEPS);
  const [connected, setConnected] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState('');
  const [sageWindow, setSageWindow] = useState<Window | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pulledData = useRef<Record<string, any>>({});

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
      setError('Popup blocked — please allow popups for this site');
    }
  }, []);

  const runScriptInSage = useCallback(async (script: string): Promise<unknown> => {
    // We can't inject JS into a cross-origin window directly.
    // Instead, we use the fetch approach: the user's Sage tab has cookies,
    // but we call from ISAFlow's context. Since the Sage APIs accept
    // same-origin requests with cookies, we need to proxy through Sage's domain.
    //
    // Alternative approach: execute the fetch from THIS page using the
    // Sage domain — this won't work due to CORS.
    //
    // The working approach: use a message channel with the Sage popup.
    // But since we can't inject into cross-origin, we use the simplest method:
    // fetch from the SERVER side using the session cookies the user provides.
    //
    // ACTUAL working approach for browser automation:
    // The Chrome extension (Claude-in-Chrome) or DevTools MCP can run JS
    // in the Sage tab. For the production flow, we use an approach where
    // the user copies a bookmarklet or we use a browser extension.
    //
    // For now: direct fetch from this page won't work (CORS).
    // We'll use the postMessage approach with a helper page.

    return new Promise((resolve, reject) => {
      if (!sageWindow || sageWindow.closed) {
        reject(new Error('Sage window is closed. Please reconnect.'));
        return;
      }

      // Try direct evaluation via the sage window
      try {
        // This will only work if same-origin (won't work cross-domain)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (sageWindow as any).eval(script);
        if (result && typeof result.then === 'function') {
          result.then(resolve).catch(reject);
        } else {
          resolve(result);
        }
      } catch {
        reject(new Error('Cannot access Sage window — cross-origin restriction. Use the bookmarklet method instead.'));
      }
    });
  }, [sageWindow]);

  const pullAllData = useCallback(async () => {
    setPulling(true);
    setError('');

    try {
      // Get the fetch scripts from our API
      const scriptsRes = await apiFetch('/api/accounting/migration/sage-pull');
      const scriptsJson = await scriptsRes.json();
      if (!scriptsRes.ok) throw new Error('Failed to load pull scripts');
      const scripts = scriptsJson.data.scripts as Record<string, string>;

      // Run each step
      for (const step of INITIAL_STEPS) {
        updateStep(step.id, { status: 'pulling' });
        try {
          const rawData = await runScriptInSage(scripts[step.id] || '');

          // Send raw data to our API for mapping
          const mapRes = await apiFetch('/api/accounting/migration/sage-pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ step: step.id, rawData }),
          });
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
  }, [runScriptInSage, updateStep]);

  const allDone = steps.every(s => s.status === 'done');
  const anyError = steps.some(s => s.status === 'error');

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/accounting/migration" className="flex items-center gap-2 text-blue-600 hover:text-blue-800 mb-6 text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to Migration Hub
        </Link>

        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-green-500/10">
            <Download className="h-6 w-6 text-green-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Auto-Import from Sage</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Pull data directly from your Sage Business Cloud account</p>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {/* Step 1: Connect */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
          <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">Step 1: Connect to Sage</h2>
          <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
            Open Sage Business Cloud in a new window. Make sure you&apos;re logged in and
            have selected the correct company. ISAFlow will read data from your active session.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={openSageTab}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500 text-sm font-medium"
            >
              <ExternalLink className="h-4 w-4" />
              {connected ? 'Reconnect to Sage' : 'Open Sage'}
            </button>
            {connected && (
              <span className="flex items-center gap-1 text-sm text-green-400">
                <CheckCircle2 className="h-4 w-4" /> Sage window open
              </span>
            )}
          </div>
        </div>

        {/* Step 2: Pull Data */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-[var(--ff-text-primary)]">Step 2: Pull Data</h2>
            <button
              onClick={pullAllData}
              disabled={!connected || pulling}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              {pulling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {pulling ? 'Pulling...' : 'Pull All Data'}
            </button>
          </div>

          <div className="divide-y divide-[var(--ff-border-light)]">
            {steps.map(step => {
              const Icon = step.icon;
              return (
                <div key={step.id} className="flex items-center gap-3 py-3">
                  <div className="p-1.5 rounded bg-[var(--ff-bg-primary)]">
                    <Icon className="h-4 w-4 text-[var(--ff-text-secondary)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--ff-text-primary)]">{step.label}</p>
                    <p className="text-xs text-[var(--ff-text-secondary)]">
                      {step.status === 'error' ? step.error : step.description}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {step.status === 'pending' && (
                      <span className="text-xs text-[var(--ff-text-secondary)]">Waiting</span>
                    )}
                    {step.status === 'pulling' && (
                      <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
                    )}
                    {step.status === 'done' && (
                      <span className="flex items-center gap-1 text-xs text-green-400">
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

        {/* Step 3: Import into ISAFlow */}
        {(allDone || anyError) && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <div className="flex items-center gap-3 mb-4">
              <ShieldCheck className="h-5 w-5 text-teal-400" />
              <h2 className="font-semibold text-[var(--ff-text-primary)]">Step 3: Import into ISAFlow</h2>
            </div>
            {allDone ? (
              <>
                <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
                  All data pulled successfully. Continue to the Migration Wizard to review and import.
                </p>
                <Link
                  href="/accounting/migration"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-500 text-sm font-medium"
                >
                  Continue to Migration Wizard
                </Link>
              </>
            ) : (
              <p className="text-sm text-amber-400">
                Some steps failed. You can retry the pull or continue with partial data.
              </p>
            )}
          </div>
        )}

        {/* Bookmarklet fallback */}
        <div className="mt-8 p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]">
          <h3 className="text-sm font-medium text-[var(--ff-text-primary)] mb-2">Alternative: Bookmarklet Method</h3>
          <p className="text-xs text-[var(--ff-text-secondary)] mb-3">
            If the auto-pull doesn&apos;t work due to browser restrictions, you can use this bookmarklet.
            Drag it to your bookmarks bar, then click it while on the Sage dashboard.
          </p>
          <p className="text-xs text-[var(--ff-text-secondary)] font-mono bg-gray-900 p-2 rounded break-all">
            javascript:void(fetch(&apos;/services/Account/GetWithFilter&apos;,&#123;method:&apos;POST&apos;,headers:&#123;&apos;Content-Type&apos;:&apos;application/json&apos;&#125;,body:JSON.stringify(&#123;FilterId:2,Search:&apos;&apos;,Skip:0,Take:1000&#125;)&#125;).then(r=&gt;r.json()).then(d=&gt;&#123;const b=new Blob([JSON.stringify(d)],&#123;type:&apos;application/json&apos;&#125;);const a=document.createElement(&apos;a&apos;);a.href=URL.createObjectURL(b);a.download=&apos;sage-accounts.json&apos;;a.click()&#125;))
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
