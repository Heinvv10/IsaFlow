/**
 * A copy of bank-catchall.helpers (#1485) so row 7 does not wait on that branch merging.
 *
 * Fault injection for the bank catch-all suites (audit WP2 row 9): a TypeError thrown AFTER a route's first write.
 *
 * `withAuth` COMMITs a response below 500 and rolls back one at 500 or above. A route whose catch answered every
 * throw 400 therefore committed whatever it had written before the crash. These helpers crash the request at a chosen
 * point after a write, through the real route and the real `withAuth`, so a suite can assert the write is gone.
 *
 * Wire them in the test file (vi.mock is hoisted per file):
 *   vi.mock('@/lib/logger', async (orig) => (await import('./bank-catchall.helpers')).loggerWithFault(await orig()));
 *   vi.mock('@/lib/neon', async (orig) => (await import('./bank-catchall.helpers')).neonWithFault(await orig()));
 */

/** One armed fault at a time; each fires once and records that it did, so a renamed log line cannot pass vacuously. */
export const faults = {
  /** Throw from `log.info` when it is called with exactly this message (the line a service logs after its write). */
  afterLog: null as string | null,
  /** Throw once the statement whose text matches this has run (its rows written, the request still open). */
  afterSql: null as RegExp | null,
  /** Pause once the statement matching this has run, until `gate` settles: the request holds its locks meanwhile. */
  holdAfterSql: null as RegExp | null,
  gate: null as Promise<void> | null,
  held: false,
  fired: [] as string[],
};

export function resetFaults(): void {
  faults.afterLog = null;
  faults.afterSql = null;
  faults.holdAfterSql = null;
  faults.gate = null;
  faults.held = false;
  faults.fired.length = 0;
}

type LoggerModule = { log: { info: (message: string, ...rest: unknown[]) => unknown } } & Record<string, unknown>;

export function loggerWithFault(real: LoggerModule): LoggerModule {
  const log = Object.create(real.log) as LoggerModule['log'];
  log.info = (message: string, ...rest: unknown[]) => {
    if (faults.afterLog !== null && message === faults.afterLog) {
      faults.afterLog = null;
      faults.fired.push(message);
      throw new TypeError(`injected fault after: ${message}`);
    }
    return real.log.info(message, ...rest);
  };
  return { ...real, log, default: log };
}

type SqlFn = ((strings: TemplateStringsArray, ...values: unknown[]) => unknown) & Record<string, unknown>;

/** The real `sql`, LAZY for every statement but the armed one (a wrapper returning Promises breaks sql.transaction). */
export function neonWithFault(real: Record<string, unknown>): Record<string, unknown> {
  const realSql = real.sql as SqlFn;
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = realSql(strings, ...values);
    const text = strings.join('?');
    const hold = faults.holdAfterSql;
    if (hold && hold.test(text)) {
      faults.holdAfterSql = null;
      return (async () => {
        const rows = await query;
        faults.held = true;
        await faults.gate;
        return rows;
      })();
    }
    const pattern = faults.afterSql;
    if (!pattern || !pattern.test(text)) return query;
    faults.afterSql = null;
    return (async () => {
      await query;
      faults.fired.push(String(pattern));
      throw new TypeError(`injected fault after: ${String(pattern)}`);
    })();
  }, realSql);
  return { ...real, sql };
}
