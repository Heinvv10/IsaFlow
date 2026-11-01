import { useEffect, useRef, useState } from 'react';
import type { DateGate } from '@/hooks/useDateGate';

/** One run of a report. Touch state only while `latest()`, and resolve false if the run failed, so it can be retried. */
export type ReportLoad = (latest: () => boolean) => Promise<boolean>;

/**
 * Runs a filter-driven report once per `query` (its request params, or '' while it cannot run) and never over a
 * refused date, so a refusal that ends on the same params keeps the report on screen. Returns true while a refused
 * date holds back a query that was not run: the report on screen is for other filters, so the page hides it.
 */
export function useGatedReportLoad(query: string, gate: DateGate, load: ReportLoad): boolean {
  const requested = useRef<string | null>(null);
  const runs = useRef(0);
  const [newest, setNewest] = useState<string | null>(null);
  useEffect(() => {
    // Read here, not from the render: a GatedDateField binds after its parent's render has read the gate.
    if (gate.blocked || requested.current === query) return;
    requested.current = query;
    setNewest(query);
    const run = ++runs.current;
    const latest = () => run === runs.current;
    void load(latest).then((ok) => { if (!ok && latest()) requested.current = null; });
  }, [query, gate.blocked, load]);
  return gate.blocked && newest !== query;
}
