/**
 * How many high-confidence suggestions the button offers. A count is a full preview (it screens up to 2 000 rows and spends
 * the company's preview quota), so it is read at most once per MIN_GAP_MS per account: a re-read asked for sooner waits out the
 * gap (one trailing read). `refreshKey` - the page's total, which moves on every list load and accept - is what asks for a re-read.
 *
 * A read in flight is NEVER dropped because the key moved (the list loading changes it within moments of the first read, and
 * dropping that answer left the button without its number for a whole minute): it lands if the account is still the same and
 * no newer read has been started, and a change that came while it ran schedules the trailing read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBulkPreview } from './bulkAcceptApi';

export const MIN_GAP_MS = 60_000;
export interface BulkCount { n: number; more: boolean }

export function useBulkCount(bankAccountId: string | null, active: boolean, refreshKey: unknown, now: () => number = Date.now) {
  const [count, setCount] = useState<BulkCount | null>(null);
  const [force, setForce] = useState(0);
  const wanted = active ? bankAccountId : null;
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const last = useRef<{ account: string; at: number } | null>(null);
  const flight = useRef<{ account: string; seq: number } | null>(null);
  const dirty = useRef(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forced = useRef(0);
  const bypass = useRef(false); // a batch was just posted or undone: the next read ignores the gap

  const read = useCallback((account: string) => {
    const mine = ++seq.current;
    flight.current = { account, seq: mine };
    dirty.current = false;
    last.current = { account, at: now() };
    fetchBulkPreview(account)
      .then((p) => { if (seq.current === mine && wantedRef.current === account) setCount({ n: p.lines.length, more: p.truncated || p.scanTruncated }); })
      .catch(() => { if (seq.current === mine && wantedRef.current === account) setCount(null); }) // the dialog reports a failure when it is opened
      .finally(() => {
        if (flight.current?.seq !== mine) return;
        flight.current = null;
        if (dirty.current && wantedRef.current === account) schedule(account); // something changed while it ran
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  const schedule = useCallback((account: string) => {
    if (timer.current) clearTimeout(timer.current);
    const l = last.current;
    const wait = !bypass.current && l && l.account === account ? Math.max(0, l.at + MIN_GAP_MS - now()) : 0;
    timer.current = setTimeout(() => { timer.current = null; bypass.current = false; if (wantedRef.current === account) read(account); }, wait);
  }, [now, read]);

  useEffect(() => {
    if (!wanted) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      seq.current += 1; flight.current = null; setCount(null);
      return;
    }
    if (force !== forced.current) { forced.current = force; bypass.current = true; }
    if (flight.current?.account === wanted) { dirty.current = true; return; } // lands on its own; a trailing read follows
    schedule(wanted);
  }, [wanted, refreshKey, force, schedule]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** A batch was just posted or undone: read again now, whatever the gap. */
  return { count, readNow: () => setForce((f) => f + 1) };
}
