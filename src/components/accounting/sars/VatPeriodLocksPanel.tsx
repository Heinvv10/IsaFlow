/**
 * VAT period locks panel — list + lock form for
 * `/api/accounting/vat-period-locks`. Wired into `pages/accounting/sars/
 * vat-locks.tsx`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { VatPeriodLockForm } from './VatPeriodLockForm';
import { VatPeriodLocksTable } from './VatPeriodLocksTable';
import type { VatPeriodLock } from './vatPeriodLockTypes';

/** The exact fallback chain other accounting pages use for a 4xx/5xx body. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const json = await res.json();
    return json.error?.message || json.message || fallback;
  } catch {
    return fallback;
  }
}

export function VatPeriodLocksPanel() {
  const [locks, setLocks] = useState<VatPeriodLock[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const res = await apiFetch('/api/accounting/vat-period-locks', { credentials: 'include' });
      if (!res.ok) { setLocks([]); setLoadError(await errorMessage(res, 'Could not load the VAT period locks - try again')); return; }
      const json = await res.json();
      setLocks(json.data?.locks ?? []);
    } catch {
      setLocks([]);
      setLoadError('Could not load the VAT period locks - try again');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const lock = async (
    periodStart: string, periodEnd: string, notes: string, overrideReason: string,
  ): Promise<string | null> => {
    const res = await apiFetch('/api/accounting/vat-period-locks', {
      method: 'POST',
      body: JSON.stringify({
        action: 'lock', periodStart, periodEnd,
        ...(notes ? { notes } : {}),
        ...(overrideReason ? { overrideReason } : {}),
      }),
    });
    if (!res.ok) {
      const msg = await errorMessage(res, 'Could not lock the VAT period - try again');
      return res.status === 403 ? 'Only an owner or admin can override blocking VAT exceptions.' : msg;
    }
    await load();
    return null;
  };

  const unlock = async (lockId: string, reason: string): Promise<string | null> => {
    const res = await apiFetch('/api/accounting/vat-period-locks', {
      method: 'POST',
      body: JSON.stringify({ action: 'unlock', lockId, reason }),
    });
    if (!res.ok) {
      const msg = await errorMessage(res, 'Could not unlock the VAT period - try again');
      return res.status === 403 ? 'Only an owner or admin can unlock a VAT period.' : msg;
    }
    await load();
    return null;
  };

  return (
    <div className="space-y-4">
      <VatPeriodLockForm onLock={lock} />
      {loadError && <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-400">{loadError}</div>}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
          <span className="ml-2 text-[var(--ff-text-secondary)]">Loading VAT period locks...</span>
        </div>
      ) : (
        <VatPeriodLocksTable locks={locks} onUnlock={unlock} />
      )}
    </div>
  );
}
