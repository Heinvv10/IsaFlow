/**
 * Retry a capture read that failed or went silent (document-capture-action 'retry').
 *
 * The server re-arms the row and answers with the document, now 'reading' again; `onRetried` hands it to the page,
 * which starts polling as it does after an upload. A refusal (409 still being read, 400 not retryable, 429 limits)
 * shows the server's message and changes nothing on the page.
 */
import { useCallback, useState } from 'react';
import { ApiEnvelopeError, apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import type { CapturedDocument } from '@/modules/accounting/types/documentCapture.types';

const FAILURE = 'Could not retry the read - try again';

export function useRetryCaptureRead(onRetried: (doc: CapturedDocument) => void) {
  const [isRetrying, setIsRetrying] = useState(false);

  const retry = useCallback(async (id: string) => {
    setIsRetrying(true);
    try {
      const res = await apiFetch('/api/accounting/document-capture-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'retry' }),
      });
      await assertOk(res, FAILURE);
      const json = await res.json() as { success?: boolean; data?: CapturedDocument; error?: { message?: string } };
      if (!json.success || !json.data) throw new ApiEnvelopeError(json.error?.message || FAILURE);
      onRetried(json.data);
    } catch (err) {
      notify.error(apiErrorMessage(err, FAILURE));
    } finally {
      setIsRetrying(false);
    }
  }, [onRetried]);

  return { retry, isRetrying };
}
