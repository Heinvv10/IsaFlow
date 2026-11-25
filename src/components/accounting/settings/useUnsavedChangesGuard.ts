/**
 * While `dirty`: the browser asks before the tab closes or reloads; a click on an
 * in-app link to another page, and browser Back/Forward, are stopped before the
 * router sees them and handed back as `pending` so the page can show a confirm.
 * Nothing is thrown (a throw from routeChangeStart is an unhandled rejection
 * through next/link). Same-page links (?tab=, #hash), new-tab and modified clicks,
 * and other origins are left alone. `push` is the guarded router.push.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';

function internalTarget(e: MouseEvent): string | null {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || (a.getAttribute('target') ?? '_self') !== '_self' || a.hasAttribute('download')) return null;
  const url = new URL((a as HTMLAnchorElement).href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return null;
  return url.pathname + url.search + url.hash;
}

export function useUnsavedChangesGuard(dirty: boolean) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const onClick = (e: MouseEvent) => {
      const href = internalTarget(e);
      if (!href) return;
      e.preventDefault(); e.stopPropagation();
      setPending(href);
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    router.beforePopState(({ as }) => { setPending(as); return false; });
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
      router.beforePopState(() => true); // Next's default
    };
  }, [dirty, router]);

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    const url = pending;
    setPending(null);
    if (url) void router.push(url);
  }, [pending, router]);
  const push = useCallback((url: string) => { if (dirty) setPending(url); else void router.push(url); }, [dirty, router]);
  return { pending, stay, leave, push };
}
