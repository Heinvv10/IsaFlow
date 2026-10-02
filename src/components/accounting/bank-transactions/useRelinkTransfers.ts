/**
 * Re-link imported transactions that are the counterpart of an existing allocation (covers 'account'
 * type pointing to a bank GL) whenever the selected bank changes. The pass is non-fatal (it never blocks
 * the list), so `failed` is the only way a user learns their transfers were not linked; anything else
 * stays silent (a 403 included: that role may not write). The route writes, so it is called only for a role that may write.
 */
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';

export function useRelinkTransfers(selectedBank: string): boolean {
  const { companyRole } = useCompany();
  const mayWrite = canWrite(companyRole);
  const [relinkFailed, setRelinkFailed] = useState(false);

  useEffect(() => {
    setRelinkFailed(false);
    if (!selectedBank || !mayWrite) return;
    let cancelled = false;
    apiFetch('/api/accounting/bank-relink-transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankAccountId: selectedBank }),
    })
      .then(async res => {
        if (cancelled) return;
        // A 403 is a role that may not write (the page also hides this call from them): nothing to say.
        if (!res.ok) { if (res.status !== 403) setRelinkFailed(true); return; }
        const json = await res.json();
        if (json?.data?.failed) setRelinkFailed(true);
      })
      .catch(() => { if (!cancelled) setRelinkFailed(true); });
    return () => { cancelled = true; };
  }, [selectedBank, mayWrite]);

  return relinkFailed;
}
