/**
 * "Bank details" on the supplier page (forensic-controls step 1): the
 * supplier's bank details with the account masked, whether they are verified
 * (derived on the server from a fingerprint of the details), the latest
 * verification — who, when, how — and, for a permitted user, Verify.
 *
 * Verify sends the fingerprint the panel was SHOWN with, so details changed
 * since the page loaded are refused (409) rather than verified unseen; the
 * panel then reloads. `apiFetch` resolves on a 4xx, so every response is
 * checked with assertOk. There is no bank-detail editor here (step 1).
 */
import { useCallback, useEffect, useState } from 'react';
import { Landmark, ShieldAlert, ShieldCheck } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';

type State = 'not_enforced' | 'no_bank_details' | 'verified' | 'unverified';
type Method = 'phone_known_number' | 'bank_confirmation_letter' | 'in_person' | 'other';

interface Entry {
  kind: 'baseline' | 'verified' | 'self_verified';
  method: Method | null;
  note: string | null;
  verifiedBy: string;
  verifiedByName: string | null;
  verifiedAt: string;
}

interface View {
  state: State;
  fingerprint: string | null;
  bank: { bankName: string | null; maskedAccount: string | null; branchCode: string | null; accountType: string | null; holder: string | null };
  verifierRole: string;
  canVerify: boolean;
  latest: Entry | null;
}

const METHODS: { value: Method; label: string }[] = [
  { value: 'phone_known_number', label: 'Phoned the supplier on a number already on file' },
  { value: 'bank_confirmation_letter', label: 'Bank confirmation letter' },
  { value: 'in_person', label: 'In person' },
  { value: 'other', label: 'Other (say how in the note)' },
];
const KIND: Record<Entry['kind'], string> = {
  baseline: 'Accepted when verification was switched on',
  verified: 'Verified',
  self_verified: 'Self-verified (the only eligible verifier)',
};
const NOTE_MAX = 500;
/** The verification's calendar date in South Africa, not UTC (a 01:00 SAST verify is that day). */
const sastDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

function StateBadge({ state, neverVerified }: { state: State; neverVerified: boolean }) {
  if (state === 'verified') {
    return <span className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-400"><ShieldCheck className="h-4 w-4" />Verified</span>;
  }
  if (state === 'unverified') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-500">
        <ShieldAlert className="h-4 w-4" />{neverVerified ? 'Unverified — not verified yet' : 'Unverified — changed since last verified'}
      </span>
    );
  }
  return <span className="text-sm text-[var(--ff-text-secondary)]">Not applicable</span>;
}

export function SupplierBankDetailsPanel({ supplierId }: { supplierId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [method, setMethod] = useState<Method>('phone_known_number');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/accounting/supplier-bank-verification?supplierId=${encodeURIComponent(supplierId)}`);
      await assertOk(res, 'Could not load the bank details - try again');
      const data = ((await res.json()) as { data?: View }).data;
      // A body without the expected shape is a failure to say so, not a panel to render.
      if (!data?.bank || typeof data.state !== 'string') throw new Error('Could not load the bank details - try again');
      setView(data);
      setError('');
    } catch (err) {
      setView(null);
      setError(apiErrorMessage(err, 'Could not load the bank details - try again'));
    }
  }, [supplierId]);

  useEffect(() => { void load(); }, [load]);

  const verify = async () => {
    if (!view?.fingerprint) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/supplier-bank-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId, fingerprint: view.fingerprint, method, note: note.trim() }),
      });
      await assertOk(res, 'Could not verify the bank details - try again');
      notify.success('Bank details verified');
      setNote('');
    } catch (err) {
      notify.error(apiErrorMessage(err, 'Could not verify the bank details - try again'));
    } finally {
      await load(); // shows the details now on file, whichever way the verify went
      setSaving(false);
    }
  };

  if (!view) return error ? <p className="text-sm text-red-500">{error}</p> : null;
  const { bank, latest } = view;
  const rows: [string, string | null][] = [
    ['Bank', bank.bankName], ['Account', bank.maskedAccount], ['Branch code', bank.branchCode],
    ['Account type', bank.accountType], ['Account holder', bank.holder],
  ];
  const noteOk = note.trim().length > 0 && note.trim().length <= NOTE_MAX;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-3" data-testid="supplier-bank-details">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-xs text-[var(--ff-text-tertiary)] uppercase"><Landmark className="h-3.5 w-3.5" />Bank details</p>
        <StateBadge state={view.state} neverVerified={!latest} />
      </div>
      <dl className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-[var(--ff-text-tertiary)]">{label}</dt>
            <dd className="text-sm text-[var(--ff-text-primary)]">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      {view.state === 'not_enforced' && (
        <p className="text-xs text-[var(--ff-text-secondary)]">Supplier bank verification is off for this company (Approvals → Enforcement).</p>
      )}
      {view.state === 'no_bank_details' && <p className="text-xs text-[var(--ff-text-secondary)]">This supplier has no bank details.</p>}
      {view.state === 'unverified' && (
        <p className="text-xs text-amber-500">
          EFT files and Netcash submissions paying this supplier are refused until someone with the {view.verifierRole} role or
          above confirms these details independently and verifies them here. Whoever set them may not, unless no one else
          in the company has the admin role or above.
        </p>
      )}
      {latest && (
        <p className="text-xs text-[var(--ff-text-secondary)]">
          Last: {KIND[latest.kind]} by {latest.verifiedByName ?? latest.verifiedBy} on {sastDate(latest.verifiedAt)}
          {latest.method && ` — ${METHODS.find((m) => m.value === latest.method)?.label ?? latest.method}`}
          {latest.note && `: “${latest.note}”`}
        </p>
      )}
      {view.state === 'unverified' && view.canVerify && (
        <div className="space-y-2 border-t border-[var(--ff-border-light)] pt-3">
          <label className="block text-xs text-[var(--ff-text-secondary)]">
            How did you confirm these details?
            <select value={method} onChange={(e) => setMethod(e.target.value as Method)} disabled={saving}
              className="mt-1 block w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]">
              {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <label className="block text-xs text-[var(--ff-text-secondary)]">
            Note (who you spoke to, the letter&apos;s date, …)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} rows={2} disabled={saving}
              className="mt-1 block w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]" />
          </label>
          <button type="button" onClick={() => { void verify(); }} disabled={saving || !noteOk}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-50">
            <ShieldCheck className="h-4 w-4" />{saving ? 'Verifying…' : 'Verify bank details'}
          </button>
        </div>
      )}
      {view.state === 'unverified' && !view.canVerify && (
        <p className="text-xs text-[var(--ff-text-secondary)]">
          You cannot verify these details here: it needs someone with the {view.verifierRole} role or above who did not set them,
          signed in as themselves.
        </p>
      )}
    </div>
  );
}
