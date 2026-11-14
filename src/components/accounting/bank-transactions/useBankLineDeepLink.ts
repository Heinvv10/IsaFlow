/**
 * `?line=<id>` on the bank page (a comment mention's link): reads that one line, whatever tab or page it is on, so the
 * drawer can open on it. Takes the list's own drawer state and returns the one to render: the list's line, else the
 * linked one. A line that cannot be read (a stale link) is a dismissible `error` beside the list, never instead of
 * it, and `?line` is dropped from the URL.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BankTx } from '@/components/accounting/BankTxTable';

export function useBankLineDeepLink(listTx: BankTx | undefined, closeListDetail: () => void) {
  const router = useRouter();
  const lineId = typeof router.query.line === 'string' ? router.query.line : null;
  const [line, setLine] = useState<BankTx | undefined>();
  const [error, setError] = useState('');

  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; });
  const dropParam = useCallback(() => {
    const r = routerRef.current;
    const { line: _drop, ...rest } = r.query;
    void r.replace({ pathname: r.pathname, query: rest }, undefined, { shallow: true });
  }, []);

  useEffect(() => {
    if (!router.isReady || lineId === null) return undefined;
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/bank-transaction-line?id=${lineId}`);
        await assertOk(res, 'Could not open that bank line - try again');
        const json = await res.json() as { data: BankTx };
        if (live) { setLine(json.data); setError(''); }
      } catch (err) {
        log.warn('Bank line deep link failed', { error: err }, 'bank-transactions');
        if (live) { setLine(undefined); setError(apiErrorMessage(err, 'Could not open that bank line - try again')); dropParam(); }
      }
    })();
    return () => { live = false; };
  }, [router.isReady, lineId, dropParam]);

  const closeDetail = useCallback(() => {
    closeListDetail();
    setLine(undefined);
    if (lineId !== null) dropParam();
  }, [closeListDetail, lineId, dropParam]);

  return { detailTx: listTx ?? line, closeDetail, error, dismissError: useCallback(() => setError(''), []) };
}
