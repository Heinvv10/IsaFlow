/**
 * Retry and Delete for a statement whose background read failed (bank or supplier).
 *
 * `baseUrl` is the statement's API URL (`/api/accounting/bank-statements/<id>`): Retry POSTs
 * `<baseUrl>/retry` and then `reload`s; Delete sends DELETE to `baseUrl` and then calls `afterDelete`.
 * A refusal (409: already being read, too long, already gone) is shown as the server's message.
 */
import { useCallback, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';

interface Options {
  baseUrl: string | null;
  reload: () => Promise<unknown>;
  afterDelete: () => void;
  notify: (msg: string, kind: 'ok' | 'err') => void;
}

export function useStatementReadActions({ baseUrl, reload, afterDelete, notify }: Options) {
  const [busy, setBusy] = useState(false);

  const retry = useCallback(async () => {
    if (!baseUrl) return;
    setBusy(true);
    try {
      const res = await apiFetch(`${baseUrl}/retry`, { method: 'POST' });
      await assertOk(res, 'Could not retry the statement - try again');
      await reload();
    } catch (err) { notify(apiErrorMessage(err, 'Could not retry the statement - try again'), 'err'); }
    finally { setBusy(false); }
  }, [baseUrl, reload, notify]);

  const remove = useCallback(async () => {
    if (!baseUrl) return;
    setBusy(true);
    try {
      const res = await apiFetch(baseUrl, { method: 'DELETE' });
      await assertOk(res, 'Could not delete the statement - try again');
      afterDelete();
    } catch (err) { notify(apiErrorMessage(err, 'Could not delete the statement - try again'), 'err'); }
    finally { setBusy(false); }
  }, [baseUrl, afterDelete, notify]);

  return { busy, retry, remove };
}
