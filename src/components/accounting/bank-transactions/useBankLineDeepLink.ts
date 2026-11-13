/**
 * `?line=<id>` on the bank page (a comment mention's link): reads that one line, whatever tab or page it is on, so the
 * drawer can open on it. `clear` forgets it and drops the parameter. A line that cannot be read says so, in `error`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BankTx } from '@/components/accounting/BankTxTable';

export function useBankLineDeepLink() {
  const router = useRouter();
  const lineId = typeof router.query.line === 'string' ? router.query.line : null;
  const [line, setLine] = useState<BankTx | undefined>();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!router.isReady || lineId === null) return undefined;
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/bank-transaction-line?id=${lineId}`);
        await assertOk(res, 'Could not open that bank line - try again');
        const json = await res.json() as { data: BankTx };
        if (live) setLine(json.data);
      } catch (err) {
        log.warn('Bank line deep link failed', { error: err }, 'bank-transactions');
        if (live) setError(apiErrorMessage(err, 'Could not open that bank line - try again'));
      }
    })();
    return () => { live = false; };
  }, [router.isReady, lineId]);

  const clear = useCallback(() => {
    setLine(undefined);
    if (lineId === null) return;
    const { line: _drop, ...rest } = router.query;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
  }, [router, lineId]);

  return { line, error, clear };
}
