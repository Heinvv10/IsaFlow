/**
 * While `dirty`: the browser asks before the tab closes or reloads (this also covers the
 * company switcher, which reloads the page); a click on an in-app link to another page,
 * browser Back/Forward, and a programmatic router.push/replace (command palette, menus)
 * are stopped before the router starts and handed back as `pending` so the page can show a
 * confirm. Nothing is thrown: a throw from routeChangeStart is an unhandled rejection
 * through next/link. Same-page links and calls (?tab=, #hash, shallow), new-tab and
 * modified clicks, downloads, `data-no-guard` anchors and other origins pass through.
 * Leave runs the ORIGINAL push, so it is not stopped again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import SingletonRouter, { useRouter } from 'next/router';

function internalTarget(e: MouseEvent): string | null {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || (a.getAttribute('target') ?? '_self') !== '_self' || a.hasAttribute('download') || a.hasAttribute('data-no-guard')) return null;
  return otherPage((a as HTMLAnchorElement).href);
}

/** Sign-in and sign-out redirects (AuthContext, AdminLayout, onboarding gate, accept-invite) must never be held back by a form. */
const AUTH_PATHS = ['/login', '/logout', '/auth'];
export const isAuthPath = (pathname: string): boolean => AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** The path to confirm, or null when `href` is this page, an auth page, another origin, or unparsable. */
function otherPage(href: string): string | null {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname === window.location.pathname || isAuthPath(url.pathname)) return null;
  return url.pathname + url.search + url.hash;
}

type Nav = (url: unknown, as?: unknown, options?: { shallow?: boolean }) => Promise<boolean>;
type Navigator = { push: Nav; replace: Nav };

function urlText(url: unknown): string {
  if (typeof url === 'string') return url;
  const o = url as { pathname?: string | null; search?: string | null } | null;
  return (o?.pathname ?? window.location.pathname) + (o?.search ?? '');
}

export function useUnsavedChangesGuard(dirty: boolean) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const originals = useRef<Navigator | null>(null);

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
    router.beforePopState(({ as }) => {
      // The browser already moved the address bar. Next gives no direction, so history.go(+-1) is not
      // possible: push this page's URL back instead (one extra history entry if the user then leaves), then ask.
      window.history.pushState(null, '', router.asPath);
      setPending(as);
      return false;
    });

    // push/replace live on the one shared router every public instance delegates to.
    const inner = SingletonRouter.router as unknown as Navigator | null;
    const wrapped: Partial<Record<'push' | 'replace', { orig: Nav; own: boolean; wrapper: Nav }>> = {};
    const live = { on: true }; // once this hook has cleaned up, a wrapper still in the chain only forwards
    if (inner) {
      originals.current = { push: inner.push.bind(inner), replace: inner.replace.bind(inner) };
      for (const name of ['push', 'replace'] as const) {
        const orig = inner[name];
        const own = Object.prototype.hasOwnProperty.call(inner, name);
        const wrapper: Nav = (url, as, options) => {
          const target = options?.shallow ? null : otherPage(urlText(as ?? url));
          if (!live.on || target === null) return orig.call(inner, url, as, options);
          setPending(target);
          return Promise.resolve(false);
        };
        inner[name] = wrapper;
        wrapped[name] = { orig, own, wrapper };
      }
    }
    return () => {
      live.on = false;
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
      // Next has no getter for the previous handler; its default is "always continue".
      router.beforePopState(() => true);
      for (const name of ['push', 'replace'] as const) {
        const w = wrapped[name];
        if (!inner || !w || inner[name] !== w.wrapper) continue; // someone else wrapped it since: leave theirs
        if (w.own) inner[name] = w.orig; else delete (inner as Partial<Navigator>)[name];
      }
      originals.current = null;
    };
  }, [dirty, router]);

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    const url = pending;
    setPending(null);
    if (url) void (originals.current?.push ?? router.push)(url);
  }, [pending, router]);
  const push = useCallback((url: string) => { if (dirty) setPending(url); else void router.push(url); }, [dirty, router]);
  return { pending, stay, leave, push };
}
