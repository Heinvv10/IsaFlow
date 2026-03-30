/**
 * ExternalMigrationWizard — steps 2-5 of the Xero/QuickBooks/Pastel wizard.
 * Sub-components (StepIndicator, FileUploadZone, etc.) live in WizardParts.tsx.
 */

'use client';

import { useState } from 'react';
import { ArrowRight, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { AccountMappingTable } from './AccountMappingTable';
import {
  StepIndicator, FileUploadZone, SummaryCard, VerifyTable, RollbackButton,
  type VerifyEntry,
} from './WizardParts';
import type { ParsedAccount, ParsedEntity, MigrationSource } from '@/modules/accounting/services/migrationParserService';

interface Props {
  source: MigrationSource;
  onDone: () => void;
  onBack: () => void;
}

type Step = 'upload' | 'mapping' | 'review' | 'verify';

interface ImportResult {
  accountsImported: number;
  customersImported: number;
  suppliersImported: number;
  openingBalancesSet: number;
  errors: string[];
}

const SOURCE_HINTS: Record<MigrationSource, { accounts: string; customers: string; suppliers: string }> = {
  xero: {
    accounts: 'Xero: Reports → Chart of Accounts → Export to CSV',
    customers: 'Xero: Contacts → Customers → Export',
    suppliers: 'Xero: Contacts → Suppliers → Export',
  },
  quickbooks: {
    accounts: 'QuickBooks: Accounting → Chart of Accounts → Export',
    customers: 'QuickBooks: Sales → Customers → Export',
    suppliers: 'QuickBooks: Expenses → Vendors → Export',
  },
  pastel: {
    accounts: 'Pastel: General Ledger → Chart of Accounts → Export to CSV',
    customers: 'Pastel: Customers → Customer List → Export',
    suppliers: 'Pastel: Suppliers → Supplier List → Export',
  },
};

export function ExternalMigrationWizard({ source, onDone, onBack }: Props) {
  const [step, setStep] = useState<Step>('upload');
  const [accounts, setAccounts] = useState<ParsedAccount[]>([]);
  const [customers, setCustomers] = useState<ParsedEntity[]>([]);
  const [suppliers, setSuppliers] = useState<ParsedEntity[]>([]);
  const [parsing, setParsing] = useState('');
  const [autoMapping, setAutoMapping] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [verifyResults, setVerifyResults] = useState<VerifyEntry[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  const hints = SOURCE_HINTS[source];

  const parseFile = async (file: File, fileType: 'accounts' | 'customers' | 'suppliers') => {
    setParsing(fileType);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('source', source);
      form.append('fileType', fileType);
      const res = await apiFetch('/api/accounting/migration-parse', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Parse failed');
      if (fileType === 'accounts') setAccounts(json.data.parsed);
      if (fileType === 'customers') setCustomers(json.data.parsed);
      if (fileType === 'suppliers') setSuppliers(json.data.parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse file');
    } finally {
      setParsing('');
    }
  };

  const runAutoMap = async () => {
    if (accounts.length === 0) return;
    setAutoMapping(true);
    // Re-submit to parser to re-apply auto-mapping
    try {
      const blob = new Blob([JSON.stringify(accounts)], { type: 'text/plain' });
      const form = new FormData();
      form.append('file', blob, 'accounts.csv');
      form.append('source', source);
      form.append('fileType', 'accounts');
      const res = await apiFetch('/api/accounting/migration-parse', { method: 'POST', body: form });
      const json = await res.json();
      if (res.ok) setAccounts(json.data.parsed);
    } catch { /* silent — mapping may still be applied */ } finally {
      setAutoMapping(false);
    }
  };

  const executeImport = async () => {
    setImporting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/migration-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, accounts, customers, suppliers }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Import failed');
      setImportResult(json.data);
      setStep('verify');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const runVerify = async () => {
    setVerifying(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/migration-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceAccounts: accounts.filter(a => a.openingBalance !== 0) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Verify failed');
      setVerifyResults(json.data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      <StepIndicator step={step} />

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {step === 'upload' && (
        <div className="space-y-4">
          <FileUploadZone label="Chart of Accounts" hint={hints.accounts} required count={accounts.length} loading={parsing === 'accounts'} onFile={f => parseFile(f, 'accounts')} />
          <FileUploadZone label="Customers" hint={hints.customers} count={customers.length} loading={parsing === 'customers'} onFile={f => parseFile(f, 'customers')} />
          <FileUploadZone label="Suppliers" hint={hints.suppliers} count={suppliers.length} loading={parsing === 'suppliers'} onFile={f => parseFile(f, 'suppliers')} />
          <div className="flex items-center justify-between pt-2">
            <button onClick={onBack} className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] underline">Back</button>
            <button onClick={() => setStep('mapping')} disabled={accounts.length === 0} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50">
              Next: Map Accounts <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {step === 'mapping' && (
        <div className="space-y-4">
          <AccountMappingTable accounts={accounts} onChange={setAccounts} onAutoMap={runAutoMap} autoMapping={autoMapping} />
          <div className="flex items-center justify-between pt-2">
            <button onClick={() => setStep('upload')} className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] underline">Back</button>
            <button onClick={() => setStep('review')} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium">
              Next: Review <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-4">
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h3 className="font-semibold text-[var(--ff-text-primary)]">Ready to import</h3>
            <div className="grid grid-cols-3 gap-3">
              <SummaryCard label="Accounts" value={accounts.filter(a => a.mappedType).length} />
              <SummaryCard label="Customers" value={customers.length} />
              <SummaryCard label="Suppliers" value={suppliers.length} />
            </div>
            {accounts.some(a => !a.mappedType) && (
              <p className="text-xs text-amber-400">{accounts.filter(a => !a.mappedType).length} unmapped account(s) will be skipped.</p>
            )}
          </div>
          <div className="flex items-center justify-between pt-2">
            <button onClick={() => setStep('mapping')} className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] underline">Back</button>
            <button onClick={executeImport} disabled={importing} className="flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-50">
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {importing ? 'Importing...' : 'Import Now'}
            </button>
          </div>
        </div>
      )}

      {step === 'verify' && importResult && (
        <div className="space-y-4">
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <div className="flex items-center gap-2 text-teal-400"><CheckCircle2 className="h-5 w-5" /><h3 className="font-semibold">Import Complete</h3></div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard label="Accounts" value={importResult.accountsImported} />
              <SummaryCard label="Customers" value={importResult.customersImported} />
              <SummaryCard label="Suppliers" value={importResult.suppliersImported} />
              <SummaryCard label="Opening Balances" value={importResult.openingBalancesSet} />
            </div>
            {importResult.errors.length > 0 && (
              <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-xs space-y-1">
                <p className="font-medium">{importResult.errors.length} error(s):</p>
                {importResult.errors.slice(0, 5).map((e, i) => <p key={i}>{e}</p>)}
                {importResult.errors.length > 5 && <p>...and {importResult.errors.length - 5} more</p>}
              </div>
            )}
          </div>

          {verifyResults.length === 0 ? (
            <button onClick={runVerify} disabled={verifying} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50">
              {verifying && <Loader2 className="h-4 w-4 animate-spin" />}
              Verify Balances
            </button>
          ) : (
            <VerifyTable results={verifyResults} />
          )}

          <div className="flex items-center justify-between pt-2">
            <RollbackButton source={source} />
            <button onClick={onDone} className="px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
