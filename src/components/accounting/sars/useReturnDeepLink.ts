/**
 * Opens a return page on the period a link names: `?from=YYYY-MM-DD&to=YYYY-MM-DD` ("Ask IsaFlow" links here so the page shows
 * the figure the answer quoted). A link with a missing, unreal or reversed date is ignored whole and the page keeps its own
 * default. `held` tells the page's own settings load not to put its default back over the link's period.
 */
import { useContext, useEffect, type MutableRefObject } from 'react';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import { localDateFromISO } from '@/lib/dateUtils';

export function readDeepLinkPeriod(query: Record<string, string | string[] | undefined>): { from: string; to: string } | null {
  const { from, to } = query;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (localDateFromISO(from) === null || localDateFromISO(to) === null || from > to) return null;
  return { from, to };
}

export function useReturnDeepLink(
  setFrom: (v: string) => void, setTo: (v: string) => void, held?: MutableRefObject<boolean>,
): void {
  // The context, not useRouter(): it is null (no link) where no router is mounted, instead of throwing.
  const router = useContext(RouterContext);
  const ready = router?.isReady ?? false;
  const query = router?.query;
  useEffect(() => {
    if (!ready || !query) return;
    const link = readDeepLinkPeriod(query);
    if (!link) return;
    if (held) held.current = true;
    setFrom(link.from);
    setTo(link.to);
    // The link's period is applied once per link, not on every state change in the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, query?.from, query?.to]);
}
