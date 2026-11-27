/**
 * Reading a thrown value that the code does not own (round 36, B36-1, R36-1): a driver, a pool or a wrapper may reject with anything, and
 * a value whose formatting throws (a toString that throws, a null-prototype object, a Symbol.toPrimitive that throws, a Proxy whose traps
 * throw, a revoked Proxy, an Error whose message getter throws) must never turn the code that reads it into a second throw. Every read of an
 * unknown thrown value, in this module and in the CLI (scripts/sage-migration), goes through these: a census test refuses a bare one
 * (sageToldCensus.test.ts).
 */

const UNREADABLE = 'an error whose message cannot be read';

/** An error's message, never throwing. */
export const told = (err: unknown): string => {
  try { return String(err instanceof Error ? err.message : err); } catch { return UNREADABLE; }
};

/** A thrown value's `code` (an errno, a SQLSTATE), read inside a try: undefined when it has none or it cannot be read. */
export const codeOf = (err: unknown): unknown => {
  try { return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined; } catch { return undefined; }
};

/**
 * A thrown value made safe to handle, at the boundary where it enters (a query's rejection, a run's own error): itself when its prototype,
 * message, code and string form all read without a throw; otherwise a plain Error saying so, so that no later `instanceof`, message or code
 * read can throw. A thrown null / undefined / primitive is kept as it is (R21-4).
 */
export const safeThrown = (raw: unknown): unknown => {
  try {
    if (raw === null || raw === undefined || (typeof raw !== 'object' && typeof raw !== 'function')) { String(raw); return raw; }
    void (raw instanceof Error);
    const { message, code } = raw as { message?: unknown; code?: unknown };
    if (message !== undefined) String(message);
    if (code !== undefined) String(code);
    String(raw);
    return raw;
  } catch {
    return new Error(UNREADABLE);
  }
};

/** A thrown value as an Error the code can read and keep: itself when it is one and safe, else an Error with what told() says. */
export const asError = (err: unknown): Error => {
  const safe = safeThrown(err);
  return safe instanceof Error ? safe : new Error(told(safe));
};
