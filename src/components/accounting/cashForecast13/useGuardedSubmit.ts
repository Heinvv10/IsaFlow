/**
 * One submit at a time. The ref flips synchronously, before React re-renders the disabled button, so a double
 * click (or Enter then click) sends one request, not two. A refused write puts the server's message in `error`;
 * a successful one runs `onSuccess` (close the dialog).
 */
import { useCallback, useRef, useState } from 'react';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';

export function useGuardedSubmit() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Runs `fn` unless a submit is in flight: on success `onSuccess`, on a refusal the message in `error`. */
  const submit = useCallback(async (fn: () => Promise<ApiResult<unknown>>, onSuccess?: () => void): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r.ok) onSuccess?.();
      else setError(r.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, error, setError, submit };
}
