/**
 * The outcome of a row action that finishes in a modal (exclude, split): `begin()` hands the keyboard grid a promise
 * that `settle(true)` resolves when the row was actually excluded or split, and `settle(false)` when the modal was
 * closed or the request failed. A new `begin()` settles the previous one as false.
 */

import { useCallback, useRef } from 'react';

export interface BankTxOutcome {
  begin: () => Promise<boolean>;
  settle: (ok: boolean) => void;
}

export function useBankTxOutcome(): BankTxOutcome {
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const begin = useCallback(() => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
  }), []);
  const settle = useCallback((ok: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(ok);
  }, []);
  return { begin, settle };
}
