import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { formatDate } from '@/utils/formatters';

/** The roles `POST /api/accounting/eft-file-release` accepts. */
const RELEASE_ROLES = ['owner', 'admin'];

interface BankFile { bank: string | null; generatedBy: string; generatedAt: string }

/**
 * A batch with an unreleased bank file cannot be sent to Netcash (netcash/submit answers 409
 * BATCH_BANK_FILE_GENERATED): the file is a way of paying it. Says so, and lets an owner/admin release the file - "it
 * was not used" - with a reason typed here. Renders nothing when the batch has no unreleased file.
 */
export function BatchBankFileNotice({ batchId }: { batchId: string }) {
  const canRelease = RELEASE_ROLES.includes(useCompany().companyRole ?? '');
  const [file, setFile] = useState<BankFile | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/accounting/eft-file-release?batchId=${encodeURIComponent(batchId)}`);
      await assertOk(res, 'Could not check the batch\'s bank file - try again');
      const json = await res.json() as { data?: { bankFile?: BankFile | null } };
      setFile(json.data?.bankFile ?? null);
    } catch (err) {
      setFile(null);
      setError(apiErrorMessage(err, 'Could not check the batch\'s bank file - try again'));
    }
  }, [batchId]);

  useEffect(() => { void load(); }, [load]);

  async function release() {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/eft-file-release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, reason: reason.trim() }),
      });
      await assertOk(res, 'Could not release the bank file - try again');
      setReason('');
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not release the bank file - try again'));
    } finally {
      setBusy(false);
    }
  }

  if (!file && !error) return null;
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm space-y-2">
      {file && (
        <>
          <p className="flex items-start gap-2 text-[var(--ff-text-primary)]">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
            <span>
              A bank file{file.bank ? ` (${file.bank.toUpperCase()})` : ''} was generated for this batch by {file.generatedBy} on{' '}
              {formatDate(file.generatedAt)}. Sending it to Netcash too would pay it twice, so Netcash is blocked until the file is released.
            </span>
          </p>
          {canRelease ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex-1 min-w-[16rem] text-xs text-[var(--ff-text-secondary)]">
                Why was the file not used?
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  className="mt-1 w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]"
                />
              </label>
              <button
                onClick={() => void release()}
                disabled={busy || reason.trim() === ''}
                className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Release bank file
              </button>
            </div>
          ) : (
            <p className="text-xs text-[var(--ff-text-secondary)]">Only an owner or admin can release a bank file.</p>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
