/**
 * Load one captured document, and keep it fresh while it is read in the background.
 *
 * `reload()` shows the spinner and hands the document to `onLoaded` (the page fills its form from it).
 * While the document is 'reading' the hook polls silently every few seconds (see usePollWhileReading):
 * it keeps what is on screen and calls `onLoaded` only once the read has ended, so a half-empty document
 * never overwrites the form. A silent poll resolves to 'stop' when the document is gone or not ours (404/403)
 * and to 'bad' for any other error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson, apiErrorMessage, ApiRequestError } from '@/lib/apiFetch';
import { usePollWhileReading, type PollOutcome } from '@/hooks/usePollWhileReading';
import type { CapturedDocument } from '@/modules/accounting/types/documentCapture.types';

export function useCapturedDocument(docId: string | string[] | undefined, onLoaded: (found: CapturedDocument) => void) {
  const [doc, setDoc] = useState<CapturedDocument | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  // The id being shown now. An answer for any other id (the page moved on while it was in flight) is dropped.
  const currentId = useRef(docId);
  currentId.current = docId;
  // Every request takes a ticket. An answer is applied only if its ticket is newer than the last APPLIED one, so
  // an earlier poll landing late cannot undo a newer reload, and a request that fails blocks nobody.
  // `loadSeq` counts the manual loads (spinner) so a superseded one still ends it.
  const seq = useRef(0);
  const appliedSeq = useRef(0);
  const loadSeq = useRef(0);

  const reload = useCallback(async (silent = false): Promise<PollOutcome> => {
    if (!docId) return 'ok';
    const ticket = ++seq.current;
    const loadTicket = silent ? loadSeq.current : ++loadSeq.current;
    const wrongDoc = () => String(currentId.current) !== String(docId);
    const stale = () => wrongDoc() || ticket < appliedSeq.current;
    if (!silent) { setIsLoading(true); setError(''); }
    try {
      const found = await apiJson(`/api/accounting/document-capture?id=${encodeURIComponent(String(docId))}`, undefined, 'Could not load the document - try again');
      if (stale()) return 'ok';
      appliedSeq.current = ticket;
      setError('');
      setDoc(found);
      if (!(silent && found.readState === 'reading')) onLoadedRef.current(found);
      return 'ok';
    } catch (err) {
      if (stale()) return 'ok';
      if (silent) return err instanceof ApiRequestError && (err.status === 404 || err.status === 403) ? 'stop' : 'bad';
      setError(apiErrorMessage(err, 'Could not load document - try again'));
      return 'bad';
    } finally {
      if (!silent && !wrongDoc() && loadTicket === loadSeq.current) setIsLoading(false);
    }
  }, [docId]);

  useEffect(() => { void reload(); }, [reload]);

  const poll = useCallback(() => reload(true), [reload]);
  usePollWhileReading(doc?.readState === 'reading' ? 'extracting' : undefined, poll);

  return { doc, isLoading, error, reload, isReading: doc?.readState === 'reading' };
}
