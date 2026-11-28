/**
 * Reading a thrown value the code does not own (rounds 36-39, B36-1, R36-1, B37-2, R39r-5): a driver, a pool, a wrapper or a tool may
 * reject with anything, and a value whose formatting throws (a toString that throws, a null-prototype object, a Symbol.toPrimitive that
 * throws, a Proxy whose traps throw or answer differently each time, a revoked Proxy, an Error whose message getter throws) must never
 * turn the code that reads it into a second throw, nor change what it is read as from one read to the next.
 *
 * So a foreign value is SNAPSHOTTED where it enters (`snapshot`): read once, each field in its own try, into our own frozen Error (its
 * message, name and stack as strings, its code and severity as primitives), and never handed on. Our own errors (OwnError) pass as they
 * are: they are told apart by identity (a WeakSet), which no Proxy trap can answer. `told`, `codeOf`, `commandOf`, `severityOf` and
 * `causeOf` read a value without a throw. Generic: no driver is imported here; the Sage migration adds pg's DatabaseError marker
 * (sageTold.ts). A census test refuses a bare read of a thrown value in the files that use these (sageToldCensus.test.ts).
 */

export const UNREADABLE = 'an error whose message cannot be read';
/** Our own errors and the snapshots we made: identity only, never a property or prototype read. */
const OURS = new WeakSet<object>();

/** The base of every error the Sage migration (and its CLI) throws: known as ours by identity. */
export class OwnError extends Error {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message, options);
    OURS.add(this);
  }
}

/** One read, never throwing: undefined when it throws. */
export const once = <T,>(read: () => T): T | undefined => {
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
 * A foreign value as our own frozen Error, read once (B37-2): its message (its own when it is an Error, else its string form), its name
 * and stack when they read as strings (R38-3), its code and severity when they read as primitives. Our own errors are returned as they
 * are. `mark` (a caller's marker, e.g. "the server's answer") is told the value and its snapshot before the snapshot is frozen; a mark
 * that throws is ignored.
 */
export const snapshot = (raw: unknown, mark?: (raw: unknown, snap: Error) => void): Error => {
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
  const e = new Error(message);
  const text = (k: 'name' | 'stack'): string | undefined => once(() => { const v = isError ? (raw as Error)[k] : undefined; return typeof v === 'string' ? v : undefined; });
  const [name, stack] = [text('name'), text('stack')];
  if (name !== undefined && name !== e.name) e.name = name; // an own name only where it differs: a plain Error's snapshot reads as before
  if (stack !== undefined) e.stack = stack;
  if (code !== undefined) (e as Error & { code?: unknown }).code = code;
  if (severity !== undefined) (e as Error & { severity?: unknown }).severity = severity;
  OURS.add(e);
  if (mark) once(() => mark(raw, e));
  return Object.freeze(e);
};
