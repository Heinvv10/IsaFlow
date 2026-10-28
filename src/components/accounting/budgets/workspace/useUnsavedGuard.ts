/**
 * While the grid holds unsaved changes (spec §5.6): closing or reloading the tab asks first
 * (`beforeunload`), and a Next route change needs a confirm; refusing it aborts the change
 * (Next's documented pattern: emit `routeChangeError`, then throw from `routeChangeStart`).
 */
import { useEffect } from 'react';
import { useRouter } from 'next/router';

export const UNSAVED_MESSAGE = 'You have unsaved budget changes. Leave without saving them?';

export function useUnsavedGuard(dirtyCount: number, message: string = UNSAVED_MESSAGE): void {
  const { events } = useRouter();
  const dirty = dirtyCount > 0;

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onRouteChange = () => {
      if (window.confirm(message)) return;
      events.emit('routeChangeError');
      throw new Error('Navigation cancelled: the budget has unsaved changes.');
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    events.on('routeChangeStart', onRouteChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      events.off('routeChangeStart', onRouteChange);
    };
  }, [dirty, message, events]);
}
