/**
 * Fault injection for the Netcash claim connection (AP-01): wraps pg.Client.prototype.query, which the app's pool
 * uses too. The claim's own connection is recognised by its send-lock query. Each rule acts once on the next matching
 * query (after `skip` matches), on the claim's connection only when `claimOnly`.
 */
import pg from 'pg';

export type Rule = {
  match: RegExp; claimOnly: boolean; skip?: number;
  act: (run: () => Promise<unknown>, client: pg.Client) => Promise<unknown>;
};

export const faults = { claim: null as null | { client: pg.Client; pid: number }, rules: [] as Rule[] };

const realQuery = pg.Client.prototype.query;

/** Install the wrapper; call the returned function to restore pg. */
export function installQueryFaults(): () => void {
  pg.Client.prototype.query = function patched(this: pg.Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    const text = typeof first === 'string' ? first : first?.text ?? '';
    if (/pg_(try_)?advisory_lock\(\$1::INT4/.test(text)) faults.claim = { client: this, pid: (this as unknown as { processID: number }).processID };
    const rule = faults.rules.find((r) => r.match.test(text) && (!r.claimOnly || this === faults.claim?.client));
    if (rule && rule.skip) rule.skip -= 1;
    else if (rule && typeof args[args.length - 1] !== 'function') {
      faults.rules.splice(faults.rules.indexOf(rule), 1);
      return rule.act(() => (realQuery as (...a: unknown[]) => Promise<unknown>).apply(this, args), this);
    }
    return (realQuery as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof realQuery;
  return () => { pg.Client.prototype.query = realQuery; };
}

export function resetFaults(): void {
  faults.claim = null;
  faults.rules = [];
}

export const injected = (what: string) => async () => { throw new Error(`injected: ${what}`); };
