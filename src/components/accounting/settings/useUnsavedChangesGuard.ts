/**
 * While `dirty`: the browser asks before the tab closes or reloads, and an
 * in-app route change is cancelled and handed back as `pending` so the page can
 * show a confirm. Shallow changes (the ?tab= query) are not leaving the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

export function useUnsavedChangesGuard(dirty: boolean) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const bypass = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const onRoute = (url: string, opts?: { shallow?: boolean }) => {
      if (bypass.current || opts?.shallow) return;
      setPending(url);
      // `cancelled` is what Next's router recognises: the push resolves false instead of rejecting.
      const err = Object.assign(new Error('Route change aborted: unsaved company settings'), { cancelled: true });
      router.events.emit('routeChangeError', err, url, { shallow: false });
      throw err;
    };
    window.addEventListener('beforeunload', onUnload);
    router.events.on('routeChangeStart', onRoute);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      router.events.off('routeChangeStart', onRoute);
    };
  }, [dirty, router]);

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    const url = pending;
    setPending(null);
    if (!url) return;
    bypass.current = true;
    void router.push(url).finally(() => { bypass.current = false; });
  }, [pending, router]);
  return { pending, stay, leave };
}
