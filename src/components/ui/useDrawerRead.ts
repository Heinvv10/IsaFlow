/**
 * useDrawerRead — one GET for a read-only drawer panel. `url` null reads nothing. A failed read is `error`, never an
 * empty `data`, so a panel cannot show "none" for something it could not load. A response for a url the panel has
 * left is dropped.
 */

import { useEffect, useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface DrawerRead<T> {
  data: T | null;
  error: string;
  loading: boolean;
}

export function useDrawerRead<T>(url: string | null, failure: string): DrawerRead<T> {
  const [read, setRead] = useState<DrawerRead<T>>({ data: null, error: '', loading: url !== null });

  useEffect(() => {
    if (url === null) return undefined;
    let live = true;
    setRead({ data: null, error: '', loading: true });
    void (async () => {
      try {
        const res = await apiFetch(url);
        await assertOk(res, failure);
        const json = await res.json() as { data: T };
        if (live) setRead({ data: json.data, error: '', loading: false });
      } catch (err) {
        log.warn('Drawer read failed', { url, error: err }, 'drawer');
        if (live) setRead({ data: null, error: apiErrorMessage(err, failure), loading: false });
      }
    })();
    return () => { live = false; };
  }, [url, failure]);

  return read;
}
