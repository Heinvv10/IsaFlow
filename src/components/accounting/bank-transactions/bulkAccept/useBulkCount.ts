/**
 * How many high-confidence suggestions the button offers. A count is a full preview (it screens up to 2 000 rows and spends
 * the company's preview quota), so it is read at most once per MIN_GAP_MS per account: a re-read asked for sooner waits out the
 * gap (one trailing read). `refreshKey` - the page's total, which moves on every list load and accept - is what asks for a re-read.
 *
 * A read in flight is NEVER dropped because the key moved (the list loading changes it within moments of the first read, and
 * dropping that answer left the button without its number for a whole minute): it lands unless a newer read of the same
 * account has been started, and a change that came while it ran schedules the trailing read.
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
  // When each account was last read: switching A, B, A within the gap does not read A again (each read screens up to 2 000
  // rows and spends preview quota).
  const last = useRef(new Map<string, number>());
  const flight = useRef<{ account: string; seq: number } | null>(null);
  const dirty = useRef(false);
  const seq = useRef(0);
  const latest = useRef(new Map<string, number>()); // the newest read's seq, per account
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forced = useRef(0);
  const bypass = useRef<string | null>(null); // a batch was just posted or undone on THIS account: its next read ignores the gap

  const read = useCallback((account: string) => {
    const mine = ++seq.current; // only read() bumps seq
    flight.current = { account, seq: mine };
    dirty.current = false;
    last.current.set(account, now());
    latest.current.set(account, mine);
    // The landing guard is per account: an answer lands unless a newer read of the SAME account was started since. A read of
    // another account, a tab switch or a refresh does not drop it (counts are stored per account).
    const lands = () => latest.current.get(account) === mine;
    fetchBulkPreview(account)
      .then((p) => { if (lands()) setCounts((c) => ({ ...c, [account]: { n: p.lines.length, more: p.truncated || p.scanTruncated } })); })
      .catch(() => { if (lands()) setCounts((c) => ({ ...c, [account]: null })); }) // the dialog reports a failure when it is opened
      .finally(() => {
        if (flight.current?.seq !== mine) return;
        flight.current = null;
        if (dirty.current && wantedRef.current === account) schedule(account); // something changed while it ran
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  const schedule = useCallback((account: string) => {
    if (timer.current) clearTimeout(timer.current);
    const at = last.current.get(account);
    const wait = bypass.current !== account && at !== undefined ? Math.max(0, at + MIN_GAP_MS - now()) : 0;
    timer.current = setTimeout(() => { timer.current = null; if (bypass.current === account) bypass.current = null; if (wantedRef.current === account) read(account); }, wait);
  }, [now, read]);

  useEffect(() => {
    if (!wanted) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      // Nothing is cancelled: a read in flight still lands (per account), and the stored counts stay, so back on the New tab
      // within the gap still shows N.
      return;
    }
    if (force !== forced.current) { forced.current = force; bypass.current = wanted; }
    if (flight.current?.account === wanted) { dirty.current = true; return; } // lands on its own; a trailing read follows
    schedule(wanted);
  }, [wanted, refreshKey, force, schedule]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /**
   * A batch was just posted or undone on `account` (the DIALOG's account, which may no longer be the page's): its stored
   * count and last read are stale. It is read again now, whatever the gap, if it is the wanted account; otherwise as soon
   * as it is wanted again. A read of it still in flight predates the change and does not land.
   */
  const invalidate = useCallback((account: string | null) => {
    if (!account) return;
    last.current.delete(account);
    latest.current.delete(account);
    setCounts((c) => { const next = { ...c }; delete next[account]; return next; });
    if (account === wantedRef.current) setForce((f) => f + 1);
  }, []);

  const count = wanted ? counts[wanted] ?? null : null;
  return { count, invalidate };
}
