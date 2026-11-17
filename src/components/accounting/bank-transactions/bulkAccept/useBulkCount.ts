/**
 * How many high-confidence suggestions the button offers. A count is a full preview (it screens up to 2 000 rows and spends
 * the company's preview quota), so it is read at most once per MIN_GAP_MS per account: a re-read asked for sooner waits out the
 * gap (a trailing read), and `refreshKey` - the page's total, which moves on every accept - is what asks for it.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchBulkPreview } from './bulkAcceptApi';

export const MIN_GAP_MS = 60_000;
export interface BulkCount { n: number; more: boolean }

export function useBulkCount(bankAccountId: string | null, active: boolean, refreshKey: unknown, now: () => number = Date.now) {
  const [count, setCount] = useState<BulkCount | null>(null);
  const [force, setForce] = useState(0);
  const lastRead = useRef<{ account: string; at: number } | null>(null);

  useEffect(() => {
    if (!bankAccountId || !active) { setCount(null); return; }
    let live = true;
    const last = lastRead.current;
    const wait = last && last.account === bankAccountId && force === 0 ? Math.max(0, last.at + MIN_GAP_MS - now()) : 0;
    const run = () => {
      lastRead.current = { account: bankAccountId, at: now() };
      fetchBulkPreview(bankAccountId)
        .then((p) => { if (live) setCount({ n: p.lines.length, more: p.truncated || p.scanTruncated }); })
        .catch(() => { if (live) setCount(null); }); // the dialog reports a failure when it is opened
    };
    const timer = setTimeout(run, wait);
    return () => { live = false; clearTimeout(timer); };
  }, [bankAccountId, active, refreshKey, force, now]);

  /** A batch was just posted or undone: read again now, whatever the gap. */
  return { count, readNow: () => setForce((f) => f + 1) };
}
