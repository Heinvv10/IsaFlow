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
  // The last count per account survives a tab switch away and back: the count shown is always the wanted account's own.
  const [counts, setCounts] = useState<Record<string, BulkCount | null>>({});
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
      // `seq` is the one landing guard: any newer read, a change of account, or the button being switched off all bump it, so
      // an answer that is no longer the latest never lands (an account check besides it would be redundant).
      .then((p) => { if (seq.current === mine) setCounts((c) => ({ ...c, [account]: { n: p.lines.length, more: p.truncated || p.scanTruncated } })); })
      .catch(() => { if (seq.current === mine) setCounts((c) => ({ ...c, [account]: null })); }) // the dialog reports a failure when it is opened
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
      // Nothing is cancelled: a read in flight still lands (per account), and the stored counts stay, so back on the New tab
      // within the gap still shows N.
      return;
    }
    if (force !== forced.current) { forced.current = force; bypass.current = true; }
    if (flight.current?.account === wanted) { dirty.current = true; return; } // lands on its own; a trailing read follows
    schedule(wanted);
  }, [wanted, refreshKey, force, schedule]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** A batch was just posted or undone: read again now, whatever the gap. */
  const count = wanted ? counts[wanted] ?? null : null;
  return { count, readNow: () => setForce((f) => f + 1) };
}
