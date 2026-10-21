/**
 * Connect to Sage — move a company's books from Sage Business Cloud Accounting
 * (South Africa) into IsaFlow in four steps: sign in to Sage, choose the Sage
 * company, review, import. Uses Sage's official API; when IsaFlow's Sage key
 * is not configured the page sends the client to the file-upload wizard.
 */
import Link from 'next/link';
import { AlertCircle, ArrowRight, CheckCircle2, CloudDownload, FileSpreadsheet, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { SageCompanyPicker, SageLoginForm, SageStepper } from '@/components/accounting/migration/sage/SageConnectSteps';
import { IssueList, SageReviewPanel } from '@/components/accounting/migration/sage/SageReviewPanel';
import { useSageConnect, type SageStep } from '@/components/accounting/migration/sage/useSageConnect';

const STEP_INDEX: Record<SageStep, 0 | 1 | 2 | 3> = { loading: 0, unavailable: 0, login: 0, company: 1, review: 2, done: 3 };
const card = 'bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6';

function Unavailable() {
  return (
    <div className={`${card} space-y-3`}>
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Connecting straight to Sage is not switched on yet</h2>
      <p className="text-sm text-[var(--ff-text-secondary)]">
        You can still bring your books across: export a few standard reports from Sage and upload them. The wizard
        tells you which report each step needs.
      </p>
      <Link href="/accounting/migration" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
        <FileSpreadsheet className="h-4 w-4" /> Upload Sage reports instead
      </Link>
    </div>
  );
}

function Done({ outcome }: { outcome: NonNullable<ReturnType<typeof useSageConnect>['outcome']> }) {
  const s = outcome.steps;
  const warnings = outcome.issues.filter((i) => i.severity === 'warning');
  const rows: [string, number][] = [
    ['Accounts', s.accounts.imported],
    ['Customers', s.customers.imported],
    ['Suppliers', s.suppliers.imported],
    ['Unpaid customer invoices', s.arInvoices.imported],
    ['Unpaid supplier bills', s.apInvoices.imported],
  ];
  return (
    <div className="space-y-5">
      <div className={`${card} flex items-start gap-4`}>
        <CheckCircle2 className="h-8 w-8 shrink-0 text-teal-400" />
        <div>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">{outcome.summary.sageCompanyName} is in IsaFlow</h2>
          <p className="text-sm text-[var(--ff-text-secondary)]">
            Balances as at {outcome.summary.asAtDate}{s.openingBalances ? ', with the opening trial balance posted' : ''}. From today, capture new
            transactions in IsaFlow rather than Sage.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {rows.map(([label, n]) => (
          <div key={label} className={`${card} p-4`}>
            <p className="text-xs text-[var(--ff-text-secondary)]">{label}</p>
            <p className="mt-1 text-xl font-semibold text-[var(--ff-text-primary)]">{n}</p>
          </div>
        ))}
      </div>
      {warnings.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Still to do</h3>
          <IssueList issues={warnings} />
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <Link href="/accounting/migration/validate" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          See the checks <ArrowRight className="h-4 w-4" />
        </Link>
        <Link href="/accounting/reports/trial-balance" className="inline-flex items-center gap-2 rounded-lg border border-[var(--ff-border-light)] px-4 py-2 text-sm text-[var(--ff-text-primary)] hover:border-blue-500">
          Open the trial balance
        </Link>
      </div>
    </div>
  );
}

export default function SageConnectPage() {
  const s = useSageConnect();
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-green-500/10 p-2"><CloudDownload className="h-6 w-6 text-green-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Import from Sage</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Bring your books across from Sage Business Cloud Accounting</p>
              </div>
            </div>
            {s.step !== 'unavailable' && s.step !== 'loading' && <SageStepper current={STEP_INDEX[s.step]} />}
          </div>
        </div>

        <div className="max-w-5xl space-y-5 p-6">
          {s.error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {s.error}
            </div>
          )}
          {s.step === 'loading' && <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>}
          {s.step === 'unavailable' && <Unavailable />}
          {s.step === 'login' && <SageLoginForm busy={s.busy === 'login'} onSubmit={s.connect} />}
          {s.step === 'company' && <SageCompanyPicker companies={s.companies} busy={s.busy === 'pull'} onPick={s.review} onBack={s.backToLogin} />}
          {s.step === 'review' && s.preview && (
            <SageReviewPanel preview={s.preview} importIssues={s.importIssues} busy={s.busy} onImport={s.runImport} onStartOver={s.startOver} />
          )}
          {s.step === 'done' && s.outcome && <Done outcome={s.outcome} />}
          {(s.step === 'login' || s.step === 'company') && (
            <p className="text-xs text-[var(--ff-text-tertiary)]">
              Prefer not to sign in to Sage here? <Link href="/accounting/migration" className="underline">Upload Sage reports instead</Link>.
            </p>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
