/**
 * The first two steps of "Connect to Sage" (sign in, choose a company) and the
 * step indicator shared by the whole page.
 */
import { useState } from 'react';
import { Building2, Check, Loader2, Lock } from 'lucide-react';

const STEPS = ['Sign in to Sage', 'Choose company', 'Review', 'Done'] as const;

export function SageStepper({ current }: { current: 0 | 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Progress">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2" aria-current={i === current ? 'step' : undefined}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full font-semibold ${
            i < current ? 'bg-teal-500 text-white' : i === current ? 'bg-blue-600 text-white' : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]'}`}>
            {i < current ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <span className={i === current ? 'font-medium text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}>{label}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-[var(--ff-border-light)]" />}
        </li>
      ))}
    </ol>
  );
}

const card = 'bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6';
const input = 'w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] focus:border-blue-500 focus:outline-none';
const primary = 'inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50';

export function SageLoginForm({ busy, onSubmit }: { busy: boolean; onSubmit: (email: string, password: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form
      className={`${card} space-y-4`}
      onSubmit={(e) => { e.preventDefault(); onSubmit(email, password); }}
    >
      <div>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Sign in to Sage Accounting</h2>
        <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">
          Use the email address and password you sign in to Sage Business Cloud Accounting with. IsaFlow reads your
          accounts, customers, suppliers, balances and unpaid invoices. It never changes anything in Sage.
        </p>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-[var(--ff-text-primary)]">Sage email address</span>
        <input className={input} type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-[var(--ff-text-primary)]">Sage password</span>
        <input className={input} type="password" autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <div className="flex items-start gap-2 rounded-lg bg-blue-500/5 p-3 text-xs text-[var(--ff-text-secondary)]">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <span>
          Your Sage password is used only to read your data for this import and is not saved anywhere. For extra peace of
          mind, add a separate user in Sage (Company → Users) just for this, and remove it when you are done.
        </span>
      </div>
      <button type="submit" className={primary} disabled={busy || !email || !password}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} {busy ? 'Signing in…' : 'Continue'}
      </button>
    </form>
  );
}

export function SageCompanyPicker({ companies, busy, onPick, onBack }: {
  companies: { id: number; name: string }[];
  busy: boolean;
  onPick: (id: number) => void;
  onBack: () => void;
}) {
  const [chosen, setChosen] = useState<number | null>(companies.length === 1 ? companies[0]!.id : null);
  if (busy) {
    return (
      <div className={`${card} flex flex-col items-center gap-3 py-12 text-center`}>
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        <p className="font-medium text-[var(--ff-text-primary)]">Reading your data from Sage…</p>
        <p className="max-w-md text-sm text-[var(--ff-text-secondary)]">Starting the read…</p>
      </div>
    );
  }
  return (
    <div className={`${card} space-y-4`}>
      <div>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Which Sage company are you moving?</h2>
        <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">
          Its books come across as at today. Nothing is imported until you have reviewed it.
        </p>
      </div>
      {companies.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-secondary)]">This Sage login has no active companies.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {companies.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setChosen(c.id)}
              className={`flex items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors ${
                chosen === c.id ? 'border-blue-500 bg-blue-500/10' : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-blue-500'}`}
            >
              <Building2 className="h-4 w-4 shrink-0 text-[var(--ff-text-secondary)]" />
              <span className="text-[var(--ff-text-primary)]">{c.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="button" className={primary} disabled={chosen === null} onClick={() => chosen !== null && onPick(chosen)}>
          Read from Sage
        </button>
        <button type="button" onClick={onBack} className="text-sm text-[var(--ff-text-secondary)] underline hover:text-[var(--ff-text-primary)]">
          Use a different Sage login
        </button>
      </div>
    </div>
  );
}

/** Step 3 while Sage is being read in the background; the page polls until the review is in. */
export function SageReading({ progress, busy, onCancel }: { progress: string | null; busy: boolean; onCancel: () => void }) {
  return (
    <div className={`${card} flex flex-col items-center gap-3 py-12 text-center`}>
      <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      <p className="font-medium text-[var(--ff-text-primary)]">Reading your data from Sage…</p>
      {progress && <p className="text-sm text-[var(--ff-text-secondary)]">{progress}</p>}
      <p className="max-w-md text-sm text-[var(--ff-text-secondary)]">
        Sage only lets IsaFlow read a little at a time, so this can take several minutes for a busy company.
        The read carries on if you leave this page; come back to Import from Sage to see the review.
      </p>
      <button type="button" onClick={onCancel} disabled={busy}
        className="text-sm text-[var(--ff-text-secondary)] underline hover:text-[var(--ff-text-primary)] disabled:opacity-50">
        Cancel the read
      </button>
    </div>
  );
}
