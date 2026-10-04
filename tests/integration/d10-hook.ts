/** D10: a one-shot statement hook for deterministic interleavings through the real routes (brk-d10's harness). */
import pg from 'pg';

/** One-shot: right BEFORE the first statement matching `re` is sent, on any pg connection, run `between` (awaited). */
export function armBefore(re: RegExp, between: () => Promise<void>) {
  const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const orig = proto.query;
  let fired = false;
  proto.query = function hooked(this: unknown, ...a: unknown[]) {
    const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
    if (!fired && re.test(t)) {
      fired = true;
      proto.query = orig;
      return between().then(() => orig.apply(this, a));
    }
    return orig.apply(this, a);
  };
  return { fired: () => fired, disarm: () => { proto.query = orig; } };
}
