/**
 * Reading a thrown value that the code does not own (rounds 36-37, B36-1, R36-1, B37-2): a driver, a pool or a wrapper may reject with
 * anything, and a value whose formatting throws (a toString that throws, a null-prototype object, a Symbol.toPrimitive that throws, a
 * Proxy whose traps throw or answer differently each time, a revoked Proxy, an Error whose message getter throws) must never turn the
 * code that reads it into a second throw, nor change what it is read as from one read to the next.
 *
 * So a foreign value is SNAPSHOTTED where it enters (`snapshot` / `safeThrown`): read once, each field in its own try, into our own
 * frozen Error (message, and code and severity as primitives), and never handed on. A real pg error keeps its code and severity,
 * and whether it is the server's answer (pg.DatabaseError), so 57P01, 55P03, 57014 and a deferred refusal classify as before. Our own
 * errors (OwnError) pass as they are: they are told apart by identity (a WeakSet), which no Proxy trap can answer. `told` and `codeOf`
 * read a value without a throw. A census test refuses a bare read in either tree (sageToldCensus.test.ts).
 */
import pg from 'pg';

const UNREADABLE = 'an error whose message cannot be read';
/** Our own errors and the snapshots we made: identity only, never a property or prototype read. */
const OURS = new WeakSet<object>();
/** For a snapshot: whether the value it was made from was the server's answer (a pg.DatabaseError). */
const SERVER = new WeakSet<object>();

/** The base of every error this module (and the CLI) throws: known as ours by identity. */
export class OwnError extends Error {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message, options);
    OURS.add(this);
  }
}

/** One read, never throwing: undefined when it throws. */
const once = <T,>(read: () => T): T | undefined => {
  try { return read(); } catch { return undefined; }
};
const isObject = (v: unknown): v is object => (typeof v === 'object' && v !== null) || typeof v === 'function';
const ours = (v: unknown): boolean => isObject(v) && OURS.has(v);

/** An error's message, never throwing. */
export const told = (err: unknown): string => {
  try { return String(err instanceof Error ? err.message : err); } catch { return UNREADABLE; }
};

/** A thrown value's `code` (an errno, a SQLSTATE), read inside a try: undefined when it has none or it cannot be read. */
export const codeOf = (err: unknown): unknown => {
  try { return isObject(err) ? (err as { code?: unknown }).code : undefined; } catch { return undefined; }
};

/** What a query answered as its command tag (pg's `command`: 'COMMIT', 'ROLLBACK'), read inside a try: undefined when unreadable. */
export const commandOf = (answer: unknown): unknown => once(() => (isObject(answer) ? (answer as { command?: unknown }).command : undefined));

/** A thrown value's `severity` and `cause`, each read inside a try: undefined when absent or unreadable. */
export const severityOf = (err: unknown): unknown => once(() => (isObject(err) ? (err as { severity?: unknown }).severity : undefined));
export const causeOf = (err: unknown): unknown => once(() => (isObject(err) ? (err as { cause?: unknown }).cause : undefined));

/**
 * A foreign value as our own frozen Error, read once (B37-2): its message (its own when it is an Error, else its string form), its code
 * and severity when they read as strings, and whether it is the server's answer. Our own errors are returned as they are.
 */
export const snapshot = (raw: unknown): Error => {
  if (ours(raw)) return raw as Error;
  const isError = once(() => raw instanceof Error) === true;
  const message = once(() => String(isError ? (raw as Error).message : raw)) ?? UNREADABLE;
  // A field as a primitive: a string (a SQLSTATE, an errno) as it is, another primitive as it is (a code that is set but not pg's, R22-4),
  // an object (which could read differently later) as a marker string that matches no rule.
  const field = (k: 'code' | 'severity'): string | number | boolean | null | undefined => once(() => {
    if (!isObject(raw)) return undefined;
    const v = (raw as Record<string, unknown>)[k];
    return isObject(v) ? '[a value that is not a primitive]' : (v as string | number | boolean | null | undefined);
  });
  const [code, severity] = [field('code'), field('severity')];
  const ServerError = (pg as { DatabaseError?: abstract new (...a: never[]) => Error }).DatabaseError;
  const server = typeof ServerError === 'function' && once(() => raw instanceof ServerError) === true;
  const e = new Error(message);
  // R38-3: a programming error's name and stack survive, as strings read in a try (never its getters again).
  const name = once(() => { const v = isError ? (raw as Error).name : undefined; return typeof v === 'string' ? v : undefined; });
  const stack = once(() => { const v = isError ? (raw as Error).stack : undefined; return typeof v === 'string' ? v : undefined; });
  if (name !== undefined && name !== e.name) e.name = name; // an own name only where it differs: a plain Error's snapshot reads as before
  if (stack !== undefined) e.stack = stack;
  if (code !== undefined) (e as Error & { code?: unknown }).code = code;
  if (severity !== undefined) (e as Error & { severity?: unknown }).severity = severity;
  OURS.add(e);
  if (server) SERVER.add(e);
  return Object.freeze(e);
};

/** Whether a snapshot (or a value, snapshotted first) was the server's own answer (a pg.DatabaseError). */
export const fromServer = (err: unknown): boolean => SERVER.has(snapshot(err));

/** A thrown value made safe where it enters: ours as it is, anything else its snapshot (never the foreign value itself). */
export const safeThrown = (raw: unknown): Error => snapshot(raw);

/** A thrown value as an Error the code can read and keep: the same as safeThrown. */
export const asError = (err: unknown): Error => snapshot(err);
