/**
 * Opens a return page on the period a link names: `?from=YYYY-MM-DD&to=YYYY-MM-DD` ("Ask IsaFlow" links here so the page shows
 * the figure the answer quoted). A link with a missing, unreal or reversed date is ignored whole and the page keeps its own
 * default. It returns the period it applied, so a page whose Generate is a pure read can run it (Generate on these pages only
 * GETs; saving a draft and filing are separate buttons). `held` tells the page's own settings load not to put its default back over the link's period.
 */
import { useEffect, useState, type MutableRefObject } from 'react';
import { useRouter } from 'next/compat/router';
import { localDateFromISO } from '@/lib/dateUtils';

export interface DeepLinkPeriod { from: string; to: string }

export function readDeepLinkPeriod(query: Record<string, string | string[] | undefined>): DeepLinkPeriod | null {
  const { from, to } = query;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (localDateFromISO(from) === null || localDateFromISO(to) === null || from > to) return null;
  return { from, to };
}

export function useReturnDeepLink(
  setFrom: (v: string) => void, setTo: (v: string) => void, held?: MutableRefObject<boolean>,
): DeepLinkPeriod | null {
  const [applied, setApplied] = useState<DeepLinkPeriod | null>(null);
  // next/compat/router: null where no router is mounted (tests, error boundaries), instead of throwing.
  const router = useRouter();
  const ready = router?.isReady ?? false;
  const query = router?.query;
  useEffect(() => {
    if (!ready || !query) return;
    const link = readDeepLinkPeriod(query);
    if (!link) return;
    if (held) held.current = true;
    setFrom(link.from);
    setTo(link.to);
    setApplied(link);
    // The link's period is applied once per link, not on every state change in the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, query?.from, query?.to]);
  return applied;
}
