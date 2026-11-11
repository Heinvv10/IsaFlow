import { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';

/**
 * Runs `open` once when the URL carries `?action=<action>` (the "+" Create menu links use it),
 * then drops the param with a shallow replace so a refresh or back does not reopen the form.
 */
export function useOpenOnAction(action: string, open: () => void): void {
  const router = useRouter();
  const openRef = useRef(open);
  openRef.current = open;
  const current = router.query.action;

  useEffect(() => {
    if (current !== action) return;
    openRef.current();
    const { action: _consumed, ...rest } = router.query;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    // router identity changes on every navigation; only the action param should re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, action]);
}
