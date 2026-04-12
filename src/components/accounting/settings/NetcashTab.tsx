/**
 * NetcashTab — Company Settings tab for Netcash integration.
 * Manage Service Key, Payouts Key, and enable/disable the integration.
 */

import { useState } from 'react';
import { Eye, EyeOff, ExternalLink, Loader2, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { Company, Toggle, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}

type TestState = 'idle' | 'loading' | 'success' | 'error';

export function NetcashTab({ company, onChange }: Props) {
  const [showServiceKey, setShowServiceKey] = useState(false);
  const [showPayoutsKey, setShowPayoutsKey] = useState(false);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [testMock, setTestMock] = useState(false);

  const handleTestConnection = async () => {
    if (!company.netcashServiceKey) {
      setTestState('error');
      setTestMessage('Enter a Service Key before testing');
      return;
    }
    setTestState('loading');
    setTestMessage('');
    try {
      const res = await apiFetch('/api/accounting/netcash/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceKey: company.netcashServiceKey }),
      });
      const json = await res.json() as { data?: { valid: boolean; error?: string; mock?: boolean } };
      const data = json.data;
      if (data?.valid) {
        setTestState('success');
        setTestMessage(data.mock ? 'Mock response (no real credentials configured)' : 'Connection successful');
        setTestMock(data.mock ?? false);
      } else {
        setTestState('error');
        setTestMessage(data?.error ?? 'Connection failed');
        setTestMock(data?.mock ?? false);
      }
    } catch {
      setTestState('error');
      setTestMessage('Network error — check your internet connection');
    }
  };

  return (
    <>
      {/* Integration Overview */}
      <section className={SECTION_CLS}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Netcash Integration</h2>
            <p className="text-sm text-[var(--ff-text-secondary)]">
              Connect ISAFlow to Netcash for EFT batch payments and debit order collections.
              Netcash is a leading South African payment gateway.
            </p>
          </div>
          <a
            href="https://www.netcash.co.za"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-teal-500 hover:text-teal-400 whitespace-nowrap"
          >
            Register at Netcash <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>

        <div className="border-t border-[var(--ff-border-primary)] pt-4">
          <Toggle
            checked={company.netcashEnabled}
            onChange={v => onChange('netcashEnabled', v)}
            label="Enable Netcash payments"
          />
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
            When enabled, EFT batches can be submitted directly to Netcash from the supplier payment screen.
          </p>
        </div>
      </section>

      {/* API Credentials */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">API Credentials</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">
          Obtain these keys from your Netcash merchant portal under API Settings.
          Keys are stored securely and never exposed to end-users.
        </p>

        <div className="space-y-4">
          {/* Service Key */}
          <div>
            <label className={LABEL_CLS}>Service Key</label>
            <div className="relative">
              <input
                type={showServiceKey ? 'text' : 'password'}
                className={`${INPUT_CLS} pr-10`}
                value={company.netcashServiceKey ?? ''}
                onChange={e => onChange('netcashServiceKey', e.target.value || null)}
                placeholder="Your Netcash Service Key"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowServiceKey(p => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
                aria-label={showServiceKey ? 'Hide service key' : 'Show service key'}
              >
                {showServiceKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
              Used to authenticate all API requests to Netcash.
            </p>
          </div>

          {/* Payouts Key */}
          <div>
            <label className={LABEL_CLS}>Payouts Key (EFT)</label>
            <div className="relative">
              <input
                type={showPayoutsKey ? 'text' : 'password'}
                className={`${INPUT_CLS} pr-10`}
                value={company.netcashPayoutsKey ?? ''}
                onChange={e => onChange('netcashPayoutsKey', e.target.value || null)}
                placeholder="Your Netcash Payouts Key"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowPayoutsKey(p => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
                aria-label={showPayoutsKey ? 'Hide payouts key' : 'Show payouts key'}
              >
                {showPayoutsKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
              Required specifically for EFT batch payment submissions.
            </p>
          </div>
        </div>

        {/* Test Connection */}
        <div className="mt-6 pt-4 border-t border-[var(--ff-border-primary)]">
          <button
            type="button"
            onClick={() => void handleTestConnection()}
            disabled={testState === 'loading'}
            className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {testState === 'loading' ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Testing...</>
            ) : (
              'Test Connection'
            )}
          </button>

          {testState === 'success' && (
            <div className={`mt-3 flex items-start gap-2 text-sm rounded-lg p-3 ${testMock ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400' : 'bg-teal-500/10 border border-teal-500/30 text-teal-500'}`}>
              {testMock ? <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" /> : <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />}
              {testMessage}
            </div>
          )}
          {testState === 'error' && (
            <div className="mt-3 flex items-start gap-2 text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400">
              <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" /> {testMessage}
            </div>
          )}
        </div>
      </section>

      {/* Help */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-3">How It Works</h2>
        <ol className="space-y-2 text-sm text-[var(--ff-text-secondary)] list-decimal list-inside">
          <li>Register a merchant account at <a href="https://www.netcash.co.za" target="_blank" rel="noopener noreferrer" className="text-teal-500 hover:underline">netcash.co.za</a>.</li>
          <li>Retrieve your Service Key and Payouts Key from the Netcash merchant portal.</li>
          <li>Enter the keys above and enable the integration.</li>
          <li>Save your company settings.</li>
          <li>In Supplier Payments, create a batch and use the &ldquo;Submit to Netcash&rdquo; action.</li>
        </ol>
      </section>
    </>
  );
}
