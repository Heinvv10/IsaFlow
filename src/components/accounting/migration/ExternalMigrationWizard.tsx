/**
 * ExternalMigrationWizard — steps 2-5 of the Xero/QuickBooks/Pastel wizard.
 * Sub-components (StepIndicator, FileUploadZone, etc.) live in WizardParts.tsx.
 */

'use client';

import { useState } from 'react';
import { ArrowRight, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { AccountMappingTable } from './AccountMappingTable';
import {
  StepIndicator, FileUploadZone, SummaryCard, VerifyTable, RollbackButton,
  type VerifyEntry,
} from './WizardParts';
import { remapAccounts, type ParsedAccount, type ParsedEntity, type MigrationSource } from '@/modules/accounting/services/core/migrationParserService';

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
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [verifyResults, setVerifyResults] = useState<VerifyEntry[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  const hints = SOURCE_HINTS[source];
  // A balance the parser could not read is carried as 0 with an error: never import it silently.
  const unreadable = [...accounts, ...customers, ...suppliers].filter(r => r.parseError);

  const parseFile = async (file: File, fileType: 'accounts' | 'customers' | 'suppliers') => {
    setParsing(fileType);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('source', source);
      form.append('fileType', fileType);
      const res = await apiFetch('/api/accounting/migration-parse', { method: 'POST', body: form });
      await assertOk(res, 'Could not parse file - try again');
      const json = await res.json();
      if (fileType === 'accounts') setAccounts(json.data.parsed);
      if (fileType === 'customers') setCustomers(json.data.parsed);
      if (fileType === 'suppliers') setSuppliers(json.data.parsed);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not parse file - try again'));
    } finally {
      setParsing('');
    }
  };

  // In memory, with the parser's own pure mapping. This used to POST
  // JSON.stringify(accounts) to the CSV parser as a "file"; it found no CSV
  // rows and the list was replaced with [] — wiping every uploaded account.
  const runAutoMap = () => {
    if (accounts.length === 0) return;
    setError('');
    setAccounts(prev => {
      const mapped = remapAccounts(source, prev);
      return mapped.length === prev.length ? mapped : prev;
    });
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
      await assertOk(res, 'Could not import the data - try again');
      setImportResult((await res.json()).data);
      setStep('verify');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not import the data - try again'));
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
      await assertOk(res, 'Could not verify the import - try again');
      const json = await res.json();
      setVerifyResults(json.data.results);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not verify the import - try again'));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      <StepIndicator step={step} />

      {unreadable.length > 0 && (
        <div role="alert" className="p-3 rounded-lg bg-red-500/10 text-red-400 text-xs space-y-1">
          <p className="font-medium">{unreadable.length} row(s) have a balance that could not be read. Fix the file and upload it again:</p>
          {unreadable.slice(0, 5).map((r, i) => <p key={i}>{'sourceName' in r ? r.sourceName : r.name}: {r.parseError}</p>)}
        </div>
      )}

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
            <button onClick={() => setStep('mapping')} disabled={accounts.length === 0} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50">
              Next: Map Accounts <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {step === 'mapping' && (
        <div className="space-y-4">
          <AccountMappingTable accounts={accounts} onChange={setAccounts} onAutoMap={runAutoMap} autoMapping={false} />
          <div className="flex items-center justify-between pt-2">
            <button onClick={() => setStep('upload')} className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] underline">Back</button>
            <button onClick={() => setStep('review')} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium">
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
            <button onClick={executeImport} disabled={importing || unreadable.length > 0} className="flex items-center gap-2 px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50">
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
            <button onClick={runVerify} disabled={verifying} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50">
              {verifying && <Loader2 className="h-4 w-4 animate-spin" />}
              Verify Balances
            </button>
          ) : (
            <VerifyTable results={verifyResults} />
          )}

          <div className="flex items-center justify-between pt-2">
            <RollbackButton source={source} />
            <button onClick={onDone} className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
