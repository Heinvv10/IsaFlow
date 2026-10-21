/**
 * Step 3 of "Connect to Sage": everything that will come across, the
 * control-account reconciliation, and any problems — before anything is
 * written. Import is disabled while there is a blocking problem.
 */
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, XCircle } from 'lucide-react';
import type { ImportIssue, SageReview } from './useSageConnect';

const rand = (n: number) => `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const card = 'bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]';
const LIST_LIMIT = 200;

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className={`${card} p-4`}>
      <p className="text-xs text-[var(--ff-text-secondary)]">{label}</p>
      <p className="mt-1 text-xl font-semibold text-[var(--ff-text-primary)]">{value}</p>
      {sub && <p className="text-xs text-[var(--ff-text-tertiary)]">{sub}</p>}
    </div>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-3 py-2">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-teal-400" /> : <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-400" />}
      <div>
        <p className="text-sm text-[var(--ff-text-primary)]">{label}</p>
        <p className="text-xs text-[var(--ff-text-secondary)]">{detail}</p>
      </div>
    </li>
  );
}

export function IssueList({ issues }: { issues: ImportIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-2">
      {issues.map((i, n) => (
        <li key={n} className={`flex items-start gap-2 rounded-lg p-3 text-sm ${i.severity === 'error' ? 'bg-red-500/10 text-red-300' : 'bg-amber-500/10 text-amber-200'}`}>
          {i.severity === 'error' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

function Details({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className={`${card} group`}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-sm font-medium text-[var(--ff-text-primary)]">
        {title}
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="max-h-96 overflow-auto border-t border-[var(--ff-border-light)] px-5 py-3">{children}</div>
    </details>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-xs">
      <thead><tr>{head.map((h) => <th key={h} className="pb-2 text-left font-medium text-[var(--ff-text-secondary)]">{h}</th>)}</tr></thead>
      <tbody>
        {rows.slice(0, LIST_LIMIT).map((r, i) => (
          <tr key={i} className="border-t border-[var(--ff-border-light)]">
            {r.map((c, j) => <td key={j} className="py-1.5 pr-3 text-[var(--ff-text-primary)]">{c}</td>)}
          </tr>
        ))}
      </tbody>
      {rows.length > LIST_LIMIT && <caption className="caption-bottom pt-2 text-left text-[var(--ff-text-tertiary)]">…and {rows.length - LIST_LIMIT} more</caption>}
    </table>
  );
}

export function SageReviewPanel({ review: r, importIssues, busy, onImport, onStartOver }: {
  review: SageReview;
  importIssues: ImportIssue[];
  busy: null | string;
  onImport: () => void;
  onStartOver: () => void;
}) {
  const t = r.totals;
  const blocking = r.issues.some((i) => i.severity === 'error');
  const arTotal = r.arInvoices.reduce((s, i) => s + i.outstanding, 0);
  const apTotal = r.apInvoices.reduce((s, i) => s + i.outstanding, 0);
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Check what will come across from {r.sageCompany.name}</h2>
        <p className="text-sm text-[var(--ff-text-secondary)]">Balances as at {r.asAtDate}. Nothing has been imported yet.</p>
      </div>

      <p className={`${card} px-5 py-3 text-xs text-[var(--ff-text-secondary)]`}>{r.profitAndLossNote}</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Accounts" value={r.accounts.length} />
        <Stat label="Customers" value={r.customers.length} />
        <Stat label="Suppliers" value={r.suppliers.length} />
        <Stat label="Unpaid customer invoices" value={r.arInvoices.length} sub={rand(arTotal)} />
        <Stat label="Unpaid supplier bills" value={r.apInvoices.length} sub={rand(apTotal)} />
      </div>

      <div className={`${card} px-5 py-3`}>
        <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Checks</h3>
        <ul className="divide-y divide-[var(--ff-border-light)]">
          <Check ok={near(t.trialBalanceDebit, t.trialBalanceCredit)} label="Sage trial balance balances"
            detail={`Debits ${rand(t.trialBalanceDebit)} · Credits ${rand(t.trialBalanceCredit)}`} />
          <Check ok={near(t.receivableControl, t.receivableDocuments)} label="Customer invoices match Trade Receivables"
            detail={`Sage control ${rand(t.receivableControl)} · invoices brought across ${rand(t.receivableDocuments)}`} />
          <Check ok={near(t.payableControl, t.payableDocuments)} label="Supplier bills match Trade Payables"
            detail={`Sage control ${rand(t.payableControl)} · bills brought across ${rand(t.payableDocuments)}`} />
        </ul>
      </div>

      <IssueList issues={importIssues.length > 0 ? importIssues : r.issues} />

      <div className="space-y-2">
        <Details title={`Chart of accounts (${r.accounts.length})`}>
          <Table head={['Code', 'Account', 'Type']} rows={r.accounts.map((a) => [a.code, a.name, a.type])} />
        </Details>
        <Details title={`Opening balances (${r.openingBalances.length} lines)`}>
          <Table head={['Code', 'Account', 'Debit', 'Credit']}
            rows={r.openingBalances.map((b) => [b.accountCode, b.name, b.debit ? rand(b.debit) : '', b.credit ? rand(b.credit) : ''])} />
          <p className="pt-2 text-xs text-[var(--ff-text-tertiary)]">
            Trade Receivables and Trade Payables come across as the unpaid invoices and bills below, not as one total.
          </p>
        </Details>
        <Details title={`Unpaid customer invoices (${r.arInvoices.length})`}>
          <Table head={['Customer', 'Invoice', 'Date', 'Outstanding']} rows={r.arInvoices.map((i) => [i.contact, i.number, i.date, rand(i.outstanding)])} />
        </Details>
        <Details title={`Unpaid supplier bills (${r.apInvoices.length})`}>
          <Table head={['Supplier', 'Bill', 'Date', 'Outstanding']} rows={r.apInvoices.map((i) => [i.contact, i.number, i.date, rand(i.outstanding)])} />
        </Details>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onImport} disabled={blocking || busy !== null}
          className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
          {busy === 'import' && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy === 'import' ? 'Importing…' : 'Import into IsaFlow'}
        </button>
        <button type="button" onClick={onStartOver} disabled={busy !== null}
          className="text-sm text-[var(--ff-text-secondary)] underline hover:text-[var(--ff-text-primary)] disabled:opacity-50">
          Start again
        </button>
        {blocking && <span className="text-xs text-red-300">Fix the items marked in red (each says where), then start again.</span>}
      </div>
    </div>
  );
}
